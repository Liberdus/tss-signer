#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use crate::common::{poll_for_broadcasts, poll_for_p2p};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// Spawns a TCP server that returns the same JSON body for every request.
    fn spawn_mock_server(response_body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        format!("http://127.0.0.1:{}", addr.port())
    }

    // --- poll_for_broadcasts: timeout ---

    #[tokio::test]
    async fn test_poll_for_broadcasts_times_out_when_party_never_responds() {
        // {"Err":null} simulates coordinator having no data yet (missing party)
        let addr = spawn_mock_server(r#"{"Err":null}"#);
        let client = reqwest::Client::new();

        let result = poll_for_broadcasts(
            &client,
            &addr,
            1,        // we are party 1
            2,        // n=2, so we wait for party 2
            "round0",
            "test-uuid".to_string(),
            1,        // 1ms delay — completes in ~200ms
        ).await;

        assert!(result.is_err(), "Should return Err after MAX_POLL_ATTEMPTS");
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("timed out"), "Error should mention timeout: {}", msg);
        assert!(msg.contains("round0"), "Error should name the round: {}", msg);
    }

    #[tokio::test]
    async fn test_poll_for_broadcasts_times_out_with_multiple_parties() {
        // n=3, we are party 2. Both other parties (1 and 3) never respond.
        let addr = spawn_mock_server(r#"{"Err":null}"#);
        let client = reqwest::Client::new();

        let result = poll_for_broadcasts(
            &client,
            &addr,
            2,
            3,
            "round1",
            "test-uuid".to_string(),
            1,
        ).await;

        assert!(result.is_err(), "Should time out waiting for unresponsive parties");
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("timed out"), "{}", msg);
    }

    // --- poll_for_broadcasts: success ---

    #[tokio::test]
    async fn test_poll_for_broadcasts_succeeds_when_data_available() {
        let addr = spawn_mock_server(r#"{"Ok":{"key":"1-round0-test-uuid","value":"party-data"}}"#);
        let client = reqwest::Client::new();

        let result = poll_for_broadcasts(
            &client,
            &addr,
            2,        // we are party 2, waiting for party 1
            2,
            "round0",
            "test-uuid".to_string(),
            1,
        ).await;

        assert!(result.is_ok(), "Should succeed when data is available");
        let values = result.unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0], "party-data");
    }

    #[tokio::test]
    async fn test_poll_for_broadcasts_returns_empty_when_only_one_party() {
        // n=1 means no other parties — loop body never runs, no HTTP call made
        let client = reqwest::Client::new();

        let result = poll_for_broadcasts(
            &client,
            "http://127.0.0.1:1",  // unreachable — should never be called
            1,
            1,
            "round0",
            "test-uuid".to_string(),
            1,
        ).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    // --- poll_for_p2p: timeout ---

    #[tokio::test]
    async fn test_poll_for_p2p_times_out_when_party_never_responds() {
        let addr = spawn_mock_server(r#"{"Err":null}"#);
        let client = reqwest::Client::new();

        let result = poll_for_p2p(
            &client,
            &addr,
            1,        // we are party 1
            2,        // n=2, wait for party 2
            1,        // 1ms delay
            "round2",
            "test-uuid".to_string(),
        ).await;

        assert!(result.is_err(), "Should return Err after MAX_POLL_ATTEMPTS");
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("timed out"), "Error should mention timeout: {}", msg);
        assert!(msg.contains("round2"), "Error should name the round: {}", msg);
    }

    // --- poll_for_p2p: success ---

    #[tokio::test]
    async fn test_poll_for_p2p_succeeds_when_data_available() {
        let addr = spawn_mock_server(r#"{"Ok":{"key":"2-1-round2-test-uuid","value":"p2p-data"}}"#);
        let client = reqwest::Client::new();

        let result = poll_for_p2p(
            &client,
            &addr,
            1,        // we are party 1, waiting for party 2's p2p message
            2,
            1,
            "round2",
            "test-uuid".to_string(),
        ).await;

        assert!(result.is_ok(), "Should succeed when p2p data is available");
        let values = result.unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0], "p2p-data");
    }

    #[tokio::test]
    async fn test_poll_for_p2p_returns_empty_when_only_one_party() {
        let client = reqwest::Client::new();

        let result = poll_for_p2p(
            &client,
            "http://127.0.0.1:1",
            1,
            1,        // n=1: no other parties
            1,
            "round2",
            "test-uuid".to_string(),
        ).await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }
}
