// SIM Generator Tooltips
export const SIM_GENERATOR_TOOLTIPS = {
  mcc: "Mobile Country Code - 3 digits identifying the country. Must match your network PLMN configuration. Examples: 001=test, 310-316=USA, 234=UK",
  mnc: "Mobile Network Code - 2-3 digits identifying the operator. Must match your network PLMN. Choose a unique or coordinated value",
  issuer: "Issuer Identifier for ICCID - 2-3 digits identifying your company. Appears in the SIM card number (ICCID) after country code",
  count: "Number of SIM credentials to generate (1-100). Each gets unique ICCID, IMSI, Ki, and OPc values",
  sequential_imsi: "Generate consecutive IMSI numbers (0000000001, 0000000002...). Easier for inventory tracking vs random generation",
  starting_msin: "First Mobile Subscriber Identification Number. Subsequent SIMs increment from here. Must fit: 15 - len(MCC) - len(MNC) digits",
  custom_adm: "Master Administrative Key (ADM1) shared by all generated SIMs. 16 hex chars (64-bit). Leave unchecked for unique per-SIM security",
  custom_pin: "Shared PIN1 (4-8 digits) for all generated SIMs. Useful for testing. Use unchecked/random for production security",
  custom_puk: "Shared PUK1 (8 digits) for PIN unlock. Same security considerations as PIN1",
  show_iccid_breakdown: "Display ICCID structure breakdown showing: MII (Major Industry), Country, Issuer, Account Number, and Luhn Checksum",
  suci_enable: "Enable SUCI (Subscription Concealed Identifier) for 5G privacy. Encrypts IMSI during network attach. Required for VoLTE",
  suci_profile: "SUCI encryption scheme. Profile A (X25519/curve25519) most common. Profile B (secp256r1/prime256v1) for specialized use",
  suci_pki: "Public Key Identifier (1-255). References the Home Network key pair when provisioning to SIMs. Must match key in Open5GS UDM",
  suci_routing: "Routing Indicator - 4 hex chars (0000-FFFF). Routes SUCI to correct UDM in multi-UDM deployments. Default: 0000 for single UDM",
  suci_public_key: "Home Network Public Key (hex string). Provision this to eSIMs along with PKI and Profile. Paired with UDM private key",
};
