// WebRTC ICE servers used to connect players.
//
// STUN lets browsers discover their public address so they can connect
// directly. That covers most home networks.
//
// TURN relays traffic when a direct connection is impossible (strict NATs,
// mobile networks, some corporate/school networks, or a firewall). The free
// public TURN servers have mostly shut down, so get your own credentials and
// add them below, for example from:
//   - Cloudflare Realtime TURN (generous free tier)
//   - Metered.ca (free tier)
//   - your own coturn server
//
// Example entry:
//   { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'],
//     username: 'user', credential: 'pass' },
//
// Note: credentials put here are visible to every player. Fine for testing;
// for a public game, issue short-lived credentials from a small backend.

export const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];
