// patch-peer-addrs patches the encrypted peer_addrs and peers fields inside
// each party's config.json vault file. This is needed when keystores were
// generated locally (all parties on 127.0.0.1) but need to be deployed to
// separate machines with real public IPs.
//
// Usage:
//
//	go run . \
//	  --keystore-root <path-to-keystores-root> \
//	  --chain-id 97 \
//	  --password 1234567890
//
// The machine-to-IP mapping and peer IDs are hardcoded below for the
// 5-party/chain-97 deployment.
package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/sha3"
)

// --- crypto types matching keystore.go ---

type cipherparamsJSON struct {
	IV string `json:"iv"`
}

type kdfParams struct {
	Memory      uint32 `json:"Memory"`
	Iterations  uint32 `json:"Iterations"`
	Parallelism uint8  `json:"Parallelism"`
	SaltLength  uint32 `json:"salt_length"`
	KeyLength   uint32 `json:"key_length"`
	Salt        string `json:"Salt"`
}

type cryptoJSON struct {
	Cipher       string           `json:"cipher"`
	CipherText   string           `json:"ciphertext"`
	CipherParams cipherparamsJSON `json:"cipherparams"`
	KDF          string           `json:"kdf"`
	KDFParams    kdfParams        `json:"kdfparams"`
	MAC          string           `json:"mac"`
}

// secretConfig is the on-disk layout of config.json.
// The "config" field is the encrypted TssConfig blob.
// ListenAddr, LogLevel, ProfileAddr, Home are stored plaintext so operators
// can adjust them without decrypting.
type secretConfig struct {
	Config      *cryptoJSON `json:"config"`
	ListenAddr  string      `json:"listen"`
	LogLevel    string      `json:"log_level"`
	ProfileAddr string      `json:"profile_addr"`
	Home        string      `json:"Home"`
}

// --- crypto helpers (mirrors keystore.go) ---

func getKDFKey(params kdfParams, passphrase string) ([]byte, error) {
	salt, err := hex.DecodeString(params.Salt)
	if err != nil {
		return nil, err
	}
	return argon2.IDKey([]byte(passphrase), salt, params.Iterations, params.Memory, params.Parallelism, params.KeyLength), nil
}

func decrypt(enc cryptoJSON, passphrase string) ([]byte, error) {
	mac, err := hex.DecodeString(enc.MAC)
	if err != nil {
		return nil, err
	}
	iv, err := hex.DecodeString(enc.CipherParams.IV)
	if err != nil {
		return nil, err
	}
	cipherText, err := hex.DecodeString(enc.CipherText)
	if err != nil {
		return nil, err
	}
	derivedKey, err := getKDFKey(enc.KDFParams, passphrase)
	if err != nil {
		return nil, err
	}

	// verify MAC = SHA3-256(derivedKey[32:] || cipherText)
	d := sha3.New256()
	d.Write(derivedKey[len(derivedKey)-16:])
	d.Write(cipherText)
	if !bytes.Equal(d.Sum(nil), mac) {
		return nil, fmt.Errorf("wrong vault passphrase or corrupted config")
	}

	block, err := aes.NewCipher(derivedKey[:len(derivedKey)-16])
	if err != nil {
		return nil, err
	}
	stream := cipher.NewCTR(block, iv)
	plainText := make([]byte, len(cipherText))
	stream.XORKeyStream(plainText, cipherText)
	return plainText, nil
}

func encrypt(plainText []byte, passphrase string, params kdfParams) (*cryptoJSON, error) {
	salt := make([]byte, params.SaltLength)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}
	params.Salt = hex.EncodeToString(salt)

	derivedKey := argon2.IDKey([]byte(passphrase), salt, params.Iterations, params.Memory, params.Parallelism, params.KeyLength)
	encKey := derivedKey[:len(derivedKey)-16]

	iv := make([]byte, aes.BlockSize)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(encKey)
	if err != nil {
		return nil, err
	}
	stream := cipher.NewCTR(block, iv)
	cipherText := make([]byte, len(plainText))
	stream.XORKeyStream(cipherText, plainText)

	d := sha3.New256()
	d.Write(derivedKey[len(derivedKey)-16:])
	d.Write(cipherText)
	mac := d.Sum(nil)

	return &cryptoJSON{
		Cipher:       "aes-256-ctr",
		CipherText:   hex.EncodeToString(cipherText),
		CipherParams: cipherparamsJSON{IV: hex.EncodeToString(iv)},
		KDF:          "Argon2id",
		KDFParams:    params,
		MAC:          hex.EncodeToString(mac),
	}, nil
}

// --- party info ---

type partyInfo struct {
	Idx     int
	IP      string
	Port    int
	Moniker string
	PeerID  string
}

func derivePort(chainId, partyIdx int) int {
	return 40000 + (chainId%1000)*10 + partyIdx
}

func buildParties(chainId int, ips, peerIDs []string) []partyInfo {
	parties := make([]partyInfo, len(ips))
	for i := range ips {
		idx := i + 1
		parties[i] = partyInfo{
			Idx:     idx,
			IP:      ips[i],
			Port:    derivePort(chainId, idx),
			Moniker: fmt.Sprintf("party-%d-chain-%d", idx, chainId),
			PeerID:  peerIDs[i],
		}
	}
	return parties
}

func multiAddr(p partyInfo) string {
	return fmt.Sprintf("/ip4/%s/tcp/%d", p.IP, p.Port)
}

func expectedPeer(p partyInfo) string {
	return fmt.Sprintf("%s@%s", p.Moniker, p.PeerID)
}

// --- patch logic ---

func patchPartyConfig(configPath string, partyIdx int, parties []partyInfo, passphrase string) error {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", configPath, err)
	}

	var sc secretConfig
	if err := json.Unmarshal(raw, &sc); err != nil {
		return fmt.Errorf("unmarshal secretConfig: %w", err)
	}
	if sc.Config == nil {
		return fmt.Errorf("config.json has no encrypted 'config' field")
	}

	plainText, err := decrypt(*sc.Config, passphrase)
	if err != nil {
		return fmt.Errorf("decrypt: %w", err)
	}

	// Parse the decrypted TssConfig as a generic map so we preserve all fields
	var tssConfig map[string]interface{}
	if err := json.Unmarshal(plainText, &tssConfig); err != nil {
		return fmt.Errorf("unmarshal TssConfig: %w", err)
	}

	// Build peer_addrs and peers for this party (all other parties)
	var peerAddrs []string
	var expectedPeers []string
	for _, p := range parties {
		if p.Idx == partyIdx {
			continue
		}
		peerAddrs = append(peerAddrs, multiAddr(p))
		expectedPeers = append(expectedPeers, expectedPeer(p))
	}

	// Navigate into p2p sub-object
	p2p, ok := tssConfig["p2p"].(map[string]interface{})
	if !ok {
		// p2p may not exist yet or may be nested differently; create it
		p2p = make(map[string]interface{})
		tssConfig["p2p"] = p2p
	}
	p2p["peer_addrs"] = peerAddrs
	p2p["peers"] = expectedPeers

	fmt.Printf("  party-%d: peer_addrs = [%s]\n", partyIdx, strings.Join(peerAddrs, ", "))

	// Re-marshal and re-encrypt
	updatedPlain, err := json.Marshal(tssConfig)
	if err != nil {
		return fmt.Errorf("marshal updated TssConfig: %w", err)
	}

	newCrypto, err := encrypt(updatedPlain, passphrase, sc.Config.KDFParams)
	if err != nil {
		return fmt.Errorf("re-encrypt: %w", err)
	}

	sc.Config = newCrypto
	out, err := json.MarshalIndent(sc, "", "    ")
	if err != nil {
		return fmt.Errorf("marshal secretConfig: %w", err)
	}

	if err := os.WriteFile(configPath, out, 0600); err != nil {
		return fmt.Errorf("write %s: %w", configPath, err)
	}
	return nil
}

func main() {
	keystoreRoot := flag.String("keystore-root", "", "Path to keystores root (e.g. keystores/keystores_5_97/bnbtss)")
	chainId := flag.Int("chain-id", 0, "Chain ID (required)")
	password := flag.String("password", "", "Vault password (BNB_TSS_PASSWORD)")
	vaultName := flag.String("vault", "default", "Vault name (subdirectory within party home)")
	ipsFlag := flag.String("ips", "", "Comma-separated list of party IPs in order (party-1 first), e.g. 1.2.3.4,5.6.7.8,...")
	peerIDsFlag := flag.String("peer-ids", "", "Comma-separated list of libp2p peer IDs in order (party-1 first). Printed on startup: 'our bootstrapper info is: id: 12D3KooW...'")
	flag.Parse()

	if *keystoreRoot == "" || *password == "" || *chainId == 0 || *ipsFlag == "" || *peerIDsFlag == "" {
		fmt.Fprintln(os.Stderr, "Usage: go run . --keystore-root <path> --chain-id <id> --password <pass> --ips <ip1,ip2,...> --peer-ids <id1,id2,...>")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  --ips       Comma-separated public IPs of each party machine, in party order (party-1 first)")
		fmt.Fprintln(os.Stderr, "  --peer-ids  Comma-separated libp2p peer IDs, in party order. Found in tss-party logs:")
		fmt.Fprintln(os.Stderr, "              'our bootstrapper info is: moniker: party-1-chain-97, id: 12D3KooW...'")
		os.Exit(1)
	}

	ips := strings.Split(*ipsFlag, ",")
	peerIDs := strings.Split(*peerIDsFlag, ",")
	for i := range ips {
		ips[i] = strings.TrimSpace(ips[i])
	}
	for i := range peerIDs {
		peerIDs[i] = strings.TrimSpace(peerIDs[i])
	}
	if len(ips) != len(peerIDs) {
		fmt.Fprintf(os.Stderr, "ERROR: --ips has %d entries but --peer-ids has %d entries; counts must match\n", len(ips), len(peerIDs))
		os.Exit(1)
	}

	parties := buildParties(*chainId, ips, peerIDs)

	for _, p := range parties {
		configPath := filepath.Join(
			*keystoreRoot,
			fmt.Sprintf("party-%d", p.Idx),
			fmt.Sprintf("chain-%d", *chainId),
			*vaultName,
			"config.json",
		)
		fmt.Printf("Patching party-%d at %s\n", p.Idx, configPath)
		if err := patchPartyConfig(configPath, p.Idx, parties, *password); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR patching party-%d: %v\n", p.Idx, err)
			os.Exit(1)
		}
		fmt.Printf("  OK\n")
	}

	fmt.Println("\nAll parties patched. Deploy updated keystores to remote machines and restart tss-party processes.")
}
