package main

import (
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/bgentry/speakeasy"
	"github.com/bnb-chain/tss/common"
	"github.com/btcsuite/btcd/btcec"
	"golang.org/x/crypto/sha3"
)

type allOutput struct {
	Compressed       string `json:"compressed"`
	EthereumPubkey   string `json:"ethereum_pubkey"`
	EthereumAddress  string `json:"ethereum_address"`
}

func main() {
	var (
		homeArg     string
		vault       string
		passwordArg string
		format      string
	)

	flag.StringVar(&homeArg, "home", "", "Path to the tss home directory or vault directory")
	flag.StringVar(&vault, "vault", "default", "Vault name inside the home directory")
	flag.StringVar(&passwordArg, "password", "", "Vault password; if empty, TSS_PASSWORD is used or you will be prompted")
	flag.StringVar(&format, "format", "compressed", "Output format: compressed, ethereum-pubkey, ethereum-address, all")
	flag.Parse()

	if homeArg == "" {
		fmt.Fprintln(os.Stderr, "missing required --home")
		os.Exit(1)
	}

	home, resolvedVault := normalizeHomeAndVault(homeArg, vault)
	passphrase := passwordArg
	if passphrase == "" {
		passphrase = os.Getenv("TSS_PASSWORD")
	}
	if passphrase == "" {
		prompt, err := speakeasy.Ask("> Password to load this vault:")
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to read password: %v\n", err)
			os.Exit(1)
		}
		passphrase = prompt
	}

	ecdsaPubKey, err := common.LoadEcdsaPubkey(home, resolvedVault, passphrase)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load public key from %s/%s: %v\n", home, resolvedVault, err)
		os.Exit(1)
	}
	btcecPubKey := (*btcec.PublicKey)(ecdsaPubKey)
	compressed := hex.EncodeToString(btcecPubKey.SerializeCompressed())
	ethPubkey := hex.EncodeToString(btcecPubKey.SerializeUncompressed()[1:])
	ethAddress := ethereumAddress(btcecPubKey.SerializeUncompressed()[1:])

	switch format {
	case "compressed":
		fmt.Printf("%s\n", compressed)
	case "ethereum-pubkey":
		fmt.Printf("%s\n", ethPubkey)
	case "ethereum-address":
		fmt.Printf("%s\n", ethAddress)
	case "all":
		output, err := json.Marshal(allOutput{
			Compressed:      compressed,
			EthereumPubkey:  ethPubkey,
			EthereumAddress: ethAddress,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed to marshal output: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("%s\n", output)
	default:
		fmt.Fprintf(os.Stderr, "unsupported --format %q\n", format)
		os.Exit(1)
	}
}

func normalizeHomeAndVault(homeArg, vault string) (string, string) {
	cleanHome := filepath.Clean(homeArg)
	if _, err := os.Stat(filepath.Join(cleanHome, "pk.json")); err == nil {
		return filepath.Dir(cleanHome), filepath.Base(cleanHome)
	}
	return cleanHome, vault
}

func ethereumAddress(uncompressedWithoutPrefix []byte) string {
	hasher := sha3.NewLegacyKeccak256()
	hasher.Write(uncompressedWithoutPrefix)
	sum := hasher.Sum(nil)
	lowerHex := hex.EncodeToString(sum[12:])
	return toChecksumAddress(lowerHex)
}

func toChecksumAddress(lowerHex string) string {
	hasher := sha3.NewLegacyKeccak256()
	hasher.Write([]byte(lowerHex))
	hashHex := hex.EncodeToString(hasher.Sum(nil))

	var builder strings.Builder
	builder.Grow(42)
	builder.WriteString("0x")
	for i, ch := range lowerHex {
		if ch >= '0' && ch <= '9' {
			builder.WriteRune(ch)
			continue
		}
		if hashHex[i] >= '8' {
			builder.WriteString(strings.ToUpper(string(ch)))
		} else {
			builder.WriteRune(ch)
		}
	}
	return builder.String()
}
