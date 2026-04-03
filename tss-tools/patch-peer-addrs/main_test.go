package main

import (
	"encoding/json"
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
			"peer_addrs":     []string{"/ip4/10.0.1.2/tcp/42012", "/ip4/10.0.1.3/tcp/41013", "/ip4/10.0.1.5/tcp/42015"},
			"peers":          []string{"party-2-chain-105@peer2", "party-3-chain-105@peer3", "party-5-chain-105@peer5"},
			"new_peer_addrs": []string{"/ip4/10.0.1.2/tcp/42012"},
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

	if err := normalizeRegroupPortsConfig(configPath, passphrase, 105, 0); err != nil {
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
	if gotNewPeerAddrs[0].(string) != "/ip4/10.0.1.2/tcp/42012" {
		t.Fatalf("new_peer_addrs unexpectedly modified: %s", gotNewPeerAddrs[0].(string))
	}
	gotNewPeers := p2p["new_peers"].([]interface{})
	if gotNewPeers[0].(string) != "party-2-chain-105@peer2" {
		t.Fatalf("new_peers unexpectedly modified: %s", gotNewPeers[0].(string))
	}
}
