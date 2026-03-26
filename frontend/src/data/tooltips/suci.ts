// SUCI Key Management Tooltips
export const SUCI_TOOLTIPS = {
  pki_id: "Public Key Identifier (1-255). Used to reference this key pair when provisioning SIMs. Must be unique per profile type",
  profile: "SUCI Protection Scheme. Profile A uses X25519 elliptic curve (most common). Profile B uses secp256r1 (alternative for specialized deployments)",
  key_file: "Path to private key file in /etc/open5gs/hnet/. Format: curve25519-{id}.key or secp256r1-{id}.key",
  public_key: "Public key in hexadecimal format. Provision this to eSIMs during personalization. Paired with private key stored in UDM",
  regenerate_warning: "Regenerating replaces the key pair. ALL eSIMs using this PKI will need reprovisioning with the new public key or they cannot attach",
  delete_file: "Also delete the private key file from disk (/etc/open5gs/hnet/). Uncheck to keep file but remove from udm.yaml configuration",
};
