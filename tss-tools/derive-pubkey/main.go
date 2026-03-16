package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/bgentry/speakeasy"
	"github.com/bnb-chain/tss/client"
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

	os.Setenv("TSS_PASSWORD", passphrase)
	compressed, err := client.LoadPubkeyAsCompressedHexString(home, resolvedVault)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load compressed public key from %s/%s: %v\n", home, resolvedVault, err)
		os.Exit(1)
	}
	ethPubkey, err := client.LoadEthereumPubkeyHexString(home, resolvedVault)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load ethereum public key from %s/%s: %v\n", home, resolvedVault, err)
		os.Exit(1)
	}
	ethAddress, err := client.LoadEthereumAddress(home, resolvedVault)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load ethereum address from %s/%s: %v\n", home, resolvedVault, err)
		os.Exit(1)
	}

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
