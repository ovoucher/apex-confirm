//! Tests for `apex_register`.
//!
//! * `unit`      one group per contract function, including every auth/role and deadline rule
//! * `vectors`   Merkle vectors shared with the TypeScript tree builder
//! * `props`     seeded property test (200 random trees and response sequences)
//! * `real_auth` the full two-signature `board_account` authorisation path
//! * `scenario`  the seeded KUSCCO-pattern journey over two periods
mod util;
mod unit;
mod real_auth;
mod vectors;
mod scenario;
mod props;
