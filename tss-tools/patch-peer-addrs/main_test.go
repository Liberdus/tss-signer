package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestDerivePartyIdxFromMoniker(t *testing.T) {
	idx, err := derivePartyIdxFromMoniker("party-4-chain-103")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if idx != 4 {
		t.Fatalf("expected 4, got %d", idx)
	}
}

func TestReplaceTCPPortPreservesIP(t *testing.T) {
	updated, err := replaceTCPPort("/ip4/69.164.244.102/tcp/42015", 41015)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if updated != "/ip4/69.164.244.102/tcp/41015" {
		t.Fatalf("unexpected addr: %s", updated)
	}
}

func TestNormalizeRegroupPortsConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	passphrase := "1234567890"

	plain := map[string]interface{}{
		"p2p": map[string]interface{}{
			"listen":         "/ip4/0.0.0.0/tcp/42014",
			"new_listen":     "/ip4/0.0.0.0/tcp/42014",
			"peer_addrs":     []string{"/ip4/10.0.1.2/tcp/42052", "/ip4/10.0.1.3/tcp/41053", "/ip4/10.0.1.5/tcp/42055"},
			"peers":          []string{"party-2-chain-105@peer2", "party-3-chain-105@peer3", "party-5-chain-105@peer5"},
			"new_peer_addrs": []string{"/ip4/10.0.1.2/tcp/42052"},
			"new_peers":      []string{"party-2-chain-105@peer2"},
		},
		"Moniker": "party-4-chain-105",
		"Id":      "peer4",
	}
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	enc, err := encrypt(plainBytes, passphrase, kdfParams{
		Memory:      65536,
		Iterations:  13,
		Parallelism: 4,
		SaltLength:  16,
		KeyLength:   48,
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	sc := secretConfig{
		Config:     enc,
		ListenAddr: "/ip4/0.0.0.0/tcp/42014",
	}
	raw, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal secret config: %v", err)
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := normalizeRegroupPortsConfig(configPath, passphrase, 105, 0, false); err != nil {
		t.Fatalf("normalizeRegroupPortsConfig: %v", err)
	}

	updatedRaw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read updated config: %v", err)
	}
	var updated secretConfig
	if err := json.Unmarshal(updatedRaw, &updated); err != nil {
		t.Fatalf("unmarshal updated secret config: %v", err)
	}
	if updated.ListenAddr != "/ip4/0.0.0.0/tcp/41054" {
		t.Fatalf("unexpected outer listen addr: %s", updated.ListenAddr)
	}
	updatedPlain, err := decrypt(*updated.Config, passphrase)
	if err != nil {
		t.Fatalf("decrypt updated config: %v", err)
	}
	var updatedTss map[string]interface{}
	if err := json.Unmarshal(updatedPlain, &updatedTss); err != nil {
		t.Fatalf("unmarshal updated tss config: %v", err)
	}
	p2p := updatedTss["p2p"].(map[string]interface{})
	if got := p2p["listen"].(string); got != "/ip4/0.0.0.0/tcp/41054" {
		t.Fatalf("unexpected inner listen addr: %s", got)
	}
	if got := p2p["new_listen"].(string); got != "" {
		t.Fatalf("expected empty new_listen, got %q", got)
	}
	gotPeerAddrs := p2p["peer_addrs"].([]interface{})
	wantPeerAddrs := []string{
		"/ip4/10.0.1.2/tcp/41052",
		"/ip4/10.0.1.3/tcp/41053",
		"/ip4/10.0.1.5/tcp/41055",
	}
	for i, want := range wantPeerAddrs {
		if gotPeerAddrs[i].(string) != want {
			t.Fatalf("peer_addrs[%d]: want %s, got %s", i, want, gotPeerAddrs[i].(string))
		}
	}
	gotPeers := p2p["peers"].([]interface{})
	wantPeers := []string{"party-2-chain-105@peer2", "party-3-chain-105@peer3", "party-5-chain-105@peer5"}
	for i, want := range wantPeers {
		if gotPeers[i].(string) != want {
			t.Fatalf("peers[%d]: want %s, got %s", i, want, gotPeers[i].(string))
		}
	}
	gotNewPeerAddrs := p2p["new_peer_addrs"].([]interface{})
	if gotNewPeerAddrs[0].(string) != "/ip4/10.0.1.2/tcp/42052" {
		t.Fatalf("new_peer_addrs unexpectedly modified: %s", gotNewPeerAddrs[0].(string))
	}
	gotNewPeers := p2p["new_peers"].([]interface{})
	if gotNewPeers[0].(string) != "party-2-chain-105@peer2" {
		t.Fatalf("new_peers unexpectedly modified: %s", gotNewPeers[0].(string))
	}
}

func TestNormalizeRegroupPortsConfigDefaultSlotMoniker(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	passphrase := "1234567890"

	plain := map[string]interface{}{
		"p2p": map[string]interface{}{
			"listen":     "/ip4/0.0.0.0/tcp/42091",
			"new_listen": "/ip4/0.0.0.0/tcp/42091",
			"peer_addrs": []string{
				"/ip4/10.0.1.2/tcp/42091",
				"/ip4/10.0.1.3/tcp/41091",
			},
			"peers": []string{
				"default-chain-109@peer2",
				"default-chain-109@peer3",
			},
		},
		"Moniker": "default-chain-109",
		"Id":      "peer1",
	}
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	enc, err := encrypt(plainBytes, passphrase, kdfParams{
		Memory:      65536,
		Iterations:  13,
		Parallelism: 4,
		SaltLength:  16,
		KeyLength:   48,
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	sc := secretConfig{
		Config:     enc,
		ListenAddr: "/ip4/0.0.0.0/tcp/42091",
	}
	raw, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal secret config: %v", err)
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := normalizeRegroupPortsConfig(configPath, passphrase, 109, 0, true); err != nil {
		t.Fatalf("normalizeRegroupPortsConfig: %v", err)
	}

	updatedRaw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read updated config: %v", err)
	}
	var updated secretConfig
	if err := json.Unmarshal(updatedRaw, &updated); err != nil {
		t.Fatalf("unmarshal updated secret config: %v", err)
	}
	if updated.ListenAddr != "/ip4/0.0.0.0/tcp/41091" {
		t.Fatalf("unexpected outer listen addr: %s", updated.ListenAddr)
	}
	updatedPlain, err := decrypt(*updated.Config, passphrase)
	if err != nil {
		t.Fatalf("decrypt updated config: %v", err)
	}
	var updatedTss map[string]interface{}
	if err := json.Unmarshal(updatedPlain, &updatedTss); err != nil {
		t.Fatalf("unmarshal updated tss config: %v", err)
	}
	p2p := updatedTss["p2p"].(map[string]interface{})
	if got := p2p["listen"].(string); got != "/ip4/0.0.0.0/tcp/41091" {
		t.Fatalf("unexpected inner listen addr: %s", got)
	}
	gotPeerAddrs := p2p["peer_addrs"].([]interface{})
	if gotPeerAddrs[0].(string) != "/ip4/10.0.1.2/tcp/41091" {
		t.Fatalf("peer_addrs[0]: got %s", gotPeerAddrs[0].(string))
	}
	if gotPeerAddrs[1].(string) != "/ip4/10.0.1.3/tcp/41091" {
		t.Fatalf("peer_addrs[1]: got %s", gotPeerAddrs[1].(string))
	}
}

func TestNormalizeRegroupPortsConfigCustomMonikersWithoutPartyIndex(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	passphrase := "1234567890"

	plain := map[string]interface{}{
		"p2p": map[string]interface{}{
			"listen":     "/ip4/0.0.0.0/tcp/42114",
			"new_listen": "/ip4/0.0.0.0/tcp/42114",
			"peer_addrs": []string{
				"/ip4/10.0.1.2/tcp/42112",
				"/ip4/10.0.1.3/tcp/41113",
				"/ip4/10.0.1.5/tcp/42115",
			},
			"peers": []string{
				"alpha@peer2",
				"bravo@peer3",
				"charlie@peer5",
			},
		},
		"Moniker": "custom-local-node",
		"Id":      "peer4",
	}
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	enc, err := encrypt(plainBytes, passphrase, kdfParams{
		Memory:      65536,
		Iterations:  13,
		Parallelism: 4,
		SaltLength:  16,
		KeyLength:   48,
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	sc := secretConfig{
		Config:     enc,
		ListenAddr: "/ip4/0.0.0.0/tcp/42114",
	}
	raw, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal secret config: %v", err)
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	if err := normalizeRegroupPortsConfig(configPath, passphrase, 111, 4, false); err != nil {
		t.Fatalf("normalizeRegroupPortsConfig: %v", err)
	}

	updatedRaw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read updated config: %v", err)
	}
	var updated secretConfig
	if err := json.Unmarshal(updatedRaw, &updated); err != nil {
		t.Fatalf("unmarshal updated secret config: %v", err)
	}
	if updated.ListenAddr != "/ip4/0.0.0.0/tcp/41114" {
		t.Fatalf("unexpected outer listen addr: %s", updated.ListenAddr)
	}
	updatedPlain, err := decrypt(*updated.Config, passphrase)
	if err != nil {
		t.Fatalf("decrypt updated config: %v", err)
	}
	var updatedTss map[string]interface{}
	if err := json.Unmarshal(updatedPlain, &updatedTss); err != nil {
		t.Fatalf("unmarshal updated tss config: %v", err)
	}
	p2p := updatedTss["p2p"].(map[string]interface{})
	gotPeerAddrs := p2p["peer_addrs"].([]interface{})
	wantPeerAddrs := []string{
		"/ip4/10.0.1.2/tcp/41112",
		"/ip4/10.0.1.3/tcp/41113",
		"/ip4/10.0.1.5/tcp/41115",
	}
	for i, want := range wantPeerAddrs {
		if gotPeerAddrs[i].(string) != want {
			t.Fatalf("peer_addrs[%d]: want %s, got %s", i, want, gotPeerAddrs[i].(string))
		}
	}
}

func TestNormalizeRegroupPortsConfigNormalizesPeerAddrsWithoutPeers(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	passphrase := "1234567890"

	plain := map[string]interface{}{
		"p2p": map[string]interface{}{
			"listen":     "/ip4/0.0.0.0/tcp/42014",
			"new_listen": "/ip4/0.0.0.0/tcp/42014",
			"peer_addrs": []string{"/ip4/10.0.1.2/tcp/42052"},
		},
		"Moniker": "party-4-chain-105",
		"Id":      "peer4",
	}
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	enc, err := encrypt(plainBytes, passphrase, kdfParams{
		Memory:      65536,
		Iterations:  13,
		Parallelism: 4,
		SaltLength:  16,
		KeyLength:   48,
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	sc := secretConfig{
		Config:     enc,
		ListenAddr: "/ip4/0.0.0.0/tcp/42014",
	}
	raw, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal secret config: %v", err)
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	callErr := normalizeRegroupPortsConfig(configPath, passphrase, 105, 4, false)
	if callErr != nil {
		t.Fatalf("normalizeRegroupPortsConfig: %v", callErr)
	}

	updatedRaw, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read updated config: %v", err)
	}
	var updated secretConfig
	if err := json.Unmarshal(updatedRaw, &updated); err != nil {
		t.Fatalf("unmarshal updated secret config: %v", err)
	}
	updatedPlain, err := decrypt(*updated.Config, passphrase)
	if err != nil {
		t.Fatalf("decrypt updated config: %v", err)
	}
	var updatedTss map[string]interface{}
	if err := json.Unmarshal(updatedPlain, &updatedTss); err != nil {
		t.Fatalf("unmarshal updated tss config: %v", err)
	}
	p2p := updatedTss["p2p"].(map[string]interface{})
	gotPeerAddrs := p2p["peer_addrs"].([]interface{})
	if gotPeerAddrs[0].(string) != "/ip4/10.0.1.2/tcp/41052" {
		t.Fatalf("expected peer_addrs to be normalized, got %s", gotPeerAddrs[0].(string))
	}
}

func TestNormalizeRegroupPortsConfigWarnsWhenMonikerFallbackUsed(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.json")
	passphrase := "1234567890"

	plain := map[string]interface{}{
		"p2p": map[string]interface{}{
			"listen":     "/ip4/0.0.0.0/tcp/42114",
			"new_listen": "/ip4/0.0.0.0/tcp/42114",
			"peer_addrs": []string{"/ip4/10.0.1.2/tcp/42112"},
		},
		"Moniker": "custom-local-node",
		"Id":      "peer4",
	}
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	enc, err := encrypt(plainBytes, passphrase, kdfParams{
		Memory:      65536,
		Iterations:  13,
		Parallelism: 4,
		SaltLength:  16,
		KeyLength:   48,
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	sc := secretConfig{
		Config:     enc,
		ListenAddr: "/ip4/0.0.0.0/tcp/42114",
	}
	raw, err := json.Marshal(sc)
	if err != nil {
		t.Fatalf("marshal secret config: %v", err)
	}
	if err := os.WriteFile(configPath, raw, 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	originalStderr := os.Stderr
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatalf("os.Pipe: %v", err)
	}
	os.Stderr = writePipe

	callErr := normalizeRegroupPortsConfig(configPath, passphrase, 111, 0, false)

	_ = writePipe.Close()
	os.Stderr = originalStderr
	stderrBytes, readErr := io.ReadAll(readPipe)
	_ = readPipe.Close()
	if readErr != nil {
		t.Fatalf("ReadAll stderr: %v", readErr)
	}
	if callErr != nil {
		t.Fatalf("normalizeRegroupPortsConfig: %v", callErr)
	}
	if !bytes.Contains(stderrBytes, []byte("could not derive local party index from moniker")) {
		t.Fatalf("expected moniker fallback warning on stderr, got %q", string(stderrBytes))
	}
	if !bytes.Contains(stderrBytes, []byte("falling back to port-based regroup normalization")) {
		t.Fatalf("expected fallback strategy in warning, got %q", string(stderrBytes))
	}
}
