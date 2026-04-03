// patch-peer-addrs patches the encrypted peer_addrs / peers fields inside
// each party's config.json vault file. This is needed when keystores were
// generated locally (all parties on 127.0.0.1) but need to be deployed to
// separate machines with real public IPs.
//
// It also supports a narrower normalization mode for post-regroup cleanup:
// restoring the persisted listen addr back to the stable base port and
// clearing any temporary regroup-only p2p.new_listen field.
//
// Usage:
//
//	go run . \
//	  --keystore-root <path-to-keystores-root> \
//	  --chain-id 97 \
//	  --password 1234567890 \
//	  --ips 1.2.3.4,5.6.7.8,... \
//	  --peer-ids 12D3KooW...,12D3KooW...,...
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
	"strconv"
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
	if chainId < 0 {
		chainId = -chainId
	}
	return 40000 + (chainId%1000)*10 + partyIdx
}

func derivePartyIdxFromMoniker(moniker string) (int, error) {
	const prefix = "party-"
	if !strings.HasPrefix(moniker, prefix) {
		return 0, fmt.Errorf("moniker %q does not start with %q", moniker, prefix)
	}
	rest := strings.TrimPrefix(moniker, prefix)
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, fmt.Errorf("moniker %q does not include a numeric party index", moniker)
	}
	idx, err := strconv.Atoi(rest[:end])
	if err != nil || idx < 1 {
		return 0, fmt.Errorf("invalid party index in moniker %q", moniker)
	}
	return idx, nil
}

func peerMoniker(expectedPeer string) string {
	parts := strings.SplitN(expectedPeer, "@", 2)
	return strings.TrimSpace(parts[0])
}

func replaceTCPPort(addr string, port int) (string, error) {
	marker := "/tcp/"
	idx := strings.LastIndex(addr, marker)
	if idx == -1 {
		return "", fmt.Errorf("address %q does not contain /tcp/", addr)
	}
	start := idx + len(marker)
	end := start
	for end < len(addr) && addr[end] >= '0' && addr[end] <= '9' {
		end++
	}
	if end == start {
		return "", fmt.Errorf("address %q does not contain a tcp port", addr)
	}
	return addr[:start] + strconv.Itoa(port) + addr[end:], nil
}

func normalizeLocalListenAddr(current string, port int) (string, error) {
	if strings.TrimSpace(current) == "" {
		return fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port), nil
	}
	return replaceTCPPort(current, port)
}

func buildParties(chainId int, ips, peerIDs, monikers []string) []partyInfo {
	parties := make([]partyInfo, len(ips))
	for i := range ips {
		idx := i + 1
		parties[i] = partyInfo{
			Idx:     idx,
			IP:      ips[i],
			Port:    derivePort(chainId, idx),
			Moniker: monikers[i],
			PeerID:  peerIDs[i],
		}
	}
	return parties
}

// readMoniker decrypts the config.json at configPath and returns the Moniker
// stored in the TssConfig blob. Returns ("", nil) if the field is absent.
func readMoniker(configPath, passphrase string) (string, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", configPath, err)
	}
	var sc secretConfig
	if err := json.Unmarshal(raw, &sc); err != nil {
		return "", fmt.Errorf("unmarshal secretConfig: %w", err)
	}
	if sc.Config == nil {
		return "", fmt.Errorf("config.json has no encrypted 'config' field")
	}
	plainText, err := decrypt(*sc.Config, passphrase)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	var tssConfig map[string]interface{}
	if err := json.Unmarshal(plainText, &tssConfig); err != nil {
		return "", fmt.Errorf("unmarshal TssConfig: %w", err)
	}
	moniker, _ := tssConfig["Moniker"].(string)
	return moniker, nil
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

func normalizeListenConfig(configPath, passphrase, listenAddr string) error {
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

	var tssConfig map[string]interface{}
	if err := json.Unmarshal(plainText, &tssConfig); err != nil {
		return fmt.Errorf("unmarshal TssConfig: %w", err)
	}

	p2p, ok := tssConfig["p2p"].(map[string]interface{})
	if !ok {
		p2p = make(map[string]interface{})
		tssConfig["p2p"] = p2p
	}

	sc.ListenAddr = listenAddr
	p2p["listen"] = listenAddr
	p2p["new_listen"] = ""

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

func normalizeRegroupPortsConfig(configPath, passphrase string, chainId, explicitPartyIdx int) error {
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

	var tssConfig map[string]interface{}
	if err := json.Unmarshal(plainText, &tssConfig); err != nil {
		return fmt.Errorf("unmarshal TssConfig: %w", err)
	}

	moniker, _ := tssConfig["Moniker"].(string)
	partyIdx := explicitPartyIdx
	if partyIdx == 0 {
		partyIdx, err = derivePartyIdxFromMoniker(moniker)
		if err != nil {
			return err
		}
	}

	p2p, ok := tssConfig["p2p"].(map[string]interface{})
	if !ok {
		p2p = make(map[string]interface{})
		tssConfig["p2p"] = p2p
	}

	basePort := derivePort(chainId, partyIdx)
	currentListen := sc.ListenAddr
	if listen, ok := p2p["listen"].(string); ok && strings.TrimSpace(listen) != "" {
		currentListen = listen
	}
	normalizedListen, err := normalizeLocalListenAddr(currentListen, basePort)
	if err != nil {
		return err
	}
	sc.ListenAddr = normalizedListen
	p2p["listen"] = normalizedListen
	p2p["new_listen"] = ""

	rawPeerAddrs, peerAddrsOK := p2p["peer_addrs"].([]interface{})
	rawPeers, peersOK := p2p["peers"].([]interface{})
	if peerAddrsOK && peersOK {
		if len(rawPeerAddrs) != len(rawPeers) {
			return fmt.Errorf("peer_addrs length %d does not match peers length %d", len(rawPeerAddrs), len(rawPeers))
		}
		normalizedPeerAddrs := make([]string, 0, len(rawPeerAddrs))
		for i := range rawPeerAddrs {
			addr, ok := rawPeerAddrs[i].(string)
			if !ok {
				return fmt.Errorf("peer_addrs[%d] is not a string", i)
			}
			peer, ok := rawPeers[i].(string)
			if !ok {
				return fmt.Errorf("peers[%d] is not a string", i)
			}
			peerIdx, err := derivePartyIdxFromMoniker(peerMoniker(peer))
			if err != nil {
				return fmt.Errorf("derive peer index from %q: %w", peer, err)
			}
			normalizedAddr, err := replaceTCPPort(addr, derivePort(chainId, peerIdx))
			if err != nil {
				return err
			}
			normalizedPeerAddrs = append(normalizedPeerAddrs, normalizedAddr)
		}
		p2p["peer_addrs"] = normalizedPeerAddrs
	}

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
	keystoreRoot := flag.String("keystore-root", "", "Path to keystores root (e.g. keystores/bnbtss)")
	chainId := flag.Int("chain-id", 0, "Chain ID (required)")
	password := flag.String("password", "", "Vault password (BNB_TSS_PASSWORD)")
	vaultName := flag.String("vault", "default", "Vault name (subdirectory within party home)")
	partyFlag := flag.Int("party", 0, "Patch only this party index (1-based). Omit to patch all parties found under keystore-root.")
	monikersFlag := flag.String("monikers", "", "Comma-separated list of monikers in party order. Only needed if custom monikers were used during tss init; defaults to party-N-chain-ID.")
	ipsFlag := flag.String("ips", "", "Comma-separated list of party IPs in order (party-1 first), e.g. 1.2.3.4,5.6.7.8,...")
	peerIDsFlag := flag.String("peer-ids", "", "Comma-separated list of libp2p peer IDs in order (party-1 first). Obtain via: tss describe --home <vault-dir> --password <pass>")
	configPathFlag := flag.String("config-path", "", "Path to a single config.json file to patch directly")
	setListenFlag := flag.String("set-listen", "", "Normalize the stored listen addr to this multiaddr and clear temporary p2p.new_listen")
	normalizeRegroupPortsFlag := flag.Bool("normalize-regroup-ports", false, "Normalize a single stored config back to base ports after regroup")
	flag.Parse()

	if *normalizeRegroupPortsFlag {
		if *configPathFlag == "" || *password == "" || *chainId == 0 {
			fmt.Fprintln(os.Stderr, "Usage: patch-peer-addrs --normalize-regroup-ports --config-path <path/to/config.json> --chain-id <id> --password <pass> [--party <idx>]")
			os.Exit(1)
		}
		if err := normalizeRegroupPortsConfig(*configPathFlag, *password, *chainId, *partyFlag); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR normalizing regroup ports: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Normalized regroup ports at %s\n", *configPathFlag)
		return
	}

	if *configPathFlag != "" || *setListenFlag != "" {
		if *configPathFlag == "" || *setListenFlag == "" || *password == "" {
			fmt.Fprintln(os.Stderr, "Usage: patch-peer-addrs --config-path <path/to/config.json> --password <pass> --set-listen <multiaddr>")
			os.Exit(1)
		}
		if err := normalizeListenConfig(*configPathFlag, *password, *setListenFlag); err != nil {
			fmt.Fprintf(os.Stderr, "ERROR normalizing listen config: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Normalized listen config at %s -> %s\n", *configPathFlag, *setListenFlag)
		return
	}

	if *keystoreRoot == "" || *password == "" || *chainId == 0 || *ipsFlag == "" || *peerIDsFlag == "" {
		fmt.Fprintln(os.Stderr, "Usage: patch-peer-addrs --keystore-root <path> --chain-id <id> --password <pass> --ips <ip1,ip2,...> --peer-ids <id1,id2,...> [--party N] [--monikers m1,m2,...]")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "  --ips       Comma-separated public IPs of each party machine, in party order (party-1 first)")
		fmt.Fprintln(os.Stderr, "  --peer-ids  Comma-separated libp2p peer IDs, in party order.")
		fmt.Fprintln(os.Stderr, "              Obtain via: tss describe --home <vault-dir> --password <pass>")
		fmt.Fprintln(os.Stderr, "              Look for the 'Id' field in the output.")
		fmt.Fprintln(os.Stderr, "  --party     (optional) patch only this party's vault. Use when each operator")
		fmt.Fprintln(os.Stderr, "              runs this tool locally against their own keystore only.")
		fmt.Fprintln(os.Stderr, "  --monikers  (optional) override synthesized monikers. Required when custom")
		fmt.Fprintln(os.Stderr, "              monikers were used during tss init and not all vaults are present.")
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

	// Validate --party is in range.
	if *partyFlag != 0 && (*partyFlag < 1 || *partyFlag > len(ips)) {
		fmt.Fprintf(os.Stderr, "ERROR: --party %d is out of range; must be between 1 and %d\n", *partyFlag, len(ips))
		os.Exit(1)
	}

	// Resolve monikers: explicit --monikers flag takes precedence, then read from
	// each vault, then fall back to synthesized "party-N-chain-ID".
	var explicitMonikers []string
	if *monikersFlag != "" {
		explicitMonikers = strings.Split(*monikersFlag, ",")
		for i := range explicitMonikers {
			explicitMonikers[i] = strings.TrimSpace(explicitMonikers[i])
		}
		if len(explicitMonikers) != len(ips) {
			fmt.Fprintf(os.Stderr, "ERROR: --monikers has %d entries but --ips has %d entries; counts must match\n", len(explicitMonikers), len(ips))
			os.Exit(1)
		}
	}

	monikers := make([]string, len(ips))
	synthesizedAny := false
	for i := range ips {
		idx := i + 1
		if len(explicitMonikers) > 0 {
			monikers[i] = explicitMonikers[i]
			continue
		}
		configPath := filepath.Join(
			*keystoreRoot,
			fmt.Sprintf("party-%d", idx),
			fmt.Sprintf("chain-%d", *chainId),
			*vaultName,
			"config.json",
		)
		moniker, err := readMoniker(configPath, *password)
		if err != nil || moniker == "" {
			monikers[i] = fmt.Sprintf("party-%d-chain-%d", idx, *chainId)
			synthesizedAny = true
		} else {
			monikers[i] = moniker
		}
	}

	if synthesizedAny && *partyFlag != 0 {
		fmt.Fprintln(os.Stderr, "WARNING: monikers for one or more remote parties could not be read and were")
		fmt.Fprintln(os.Stderr, "         synthesized as party-N-chain-ID. If custom monikers were used during")
		fmt.Fprintln(os.Stderr, "         tss init, pass --monikers to provide the correct values.")
	}

	parties := buildParties(*chainId, ips, peerIDs, monikers)

	for _, p := range parties {
		if *partyFlag != 0 && p.Idx != *partyFlag {
			continue
		}
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

	fmt.Println("\nDone. Restart the tss-party process for the patched party.")
}
