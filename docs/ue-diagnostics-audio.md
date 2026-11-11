# UE Diagnostics audio

Select a connected UE and capture every relevant APN address, including IMS.
Start before the call so captured SIP/SDP can identify the media endpoints,
dynamic RTP payload types, codec clock rates and payload parameters. The player
keeps each direction and SSRC separate. A dynamic payload number alone never
identifies a codec. If SDP is unavailable, select the codec and format manually.

## Playback

| Codec / transport | Support |
| --- | --- |
| G.711 PCMU / PCMA | Built-in decoder, including dynamic types identified by SDP |
| AMR narrowband | FFmpeg decoder; RFC 4867 octet-aligned and bandwidth-efficient mono |
| AMR-WB | FFmpeg decoder; RFC 4867 octet-aligned and bandwidth-efficient mono |
| EVS primary | Official 3GPP reference decoder; compact and header-full RTP |
| EVS AMR-WB IO | Compact and header-full RTP, including the 56-bit SID special case |
| SRTP | AES_CM_128_HMAC_SHA1_80 and AES_CM_128_HMAC_SHA1_32 with a supplied key, KDR=0, no MKI |

AMR CRC, robust sorting, interleaving and multi-channel speech are rejected
explicitly. EVS uses a 16 kHz RTP clock and a 48 kHz playback rate; AMR-WB plays
at 16 kHz and AMR/G.711 at 8 kHz. Short RTP gaps preserve timing. The decoder
warms up on a bounded recent window before returning only new samples for live
playback. This is buffered monitoring, not a complete forensic jitter-buffer
or frame-loss-concealment implementation. Download the full PCAPNG for analysis.

## Installation

The module checks the local tshark/FFmpeg decoders, host dumpcap and persistent
EVS executable. **Check & install missing tools** installs missing Debian/Ubuntu
packages, then downloads and verifies the pinned official ETSI TS 126 443
v18.0.0 source archive and builds EVS_dec. No reference codec source or binary is
redistributed by this repository. The original archive, readme and provenance
remain alongside the executable under `/app/data/ue-codecs`, on the data volume.
FFmpeg is included in new backend images; the installer also handles older ones.
Installation does not change IMS/radio configuration or restart core services.

## SRTP

Automatic discovery checks captured SDES and existing IMS HEP/SIP traces for the
selected media tuple. SDP codec mappings use the receiving endpoint, while SDES
keys belong to the sending endpoint. Candidate keys must authenticate the RTP
packet before use. Only the discovery source is returned to the browser.
Tracing is not enabled implicitly, and keys are not retained in the audio cache.


For manual keys, expand **Codec settings / SRTP key**, select a stream, provide its suite,
base64-encoded 30-byte master key plus salt, and initial rollover counter
(normally zero when capturing from the beginning), then apply the settings.
Each direction can have a different key. Authentication is checked before any
payload is decoded; an incorrect key, suite or counter returns an error.

The key travels only in the authenticated audio POST body. It is not placed in
URLs, manifests, command arguments, caches, application logs or browser storage.
Changing capture/direction clears it. Temporary decoded speech files have
private permissions and are removed after decoding. Protect access to PCAPNG
files themselves: captured SDP can contain SDES key material.

SRTP support does not derive keys from SIP credentials, perform DTLS key exchange,
decrypt IPsec/ESP or decode encrypted SIP. Those require their own session state
and keys; the module never disables encryption to obtain audio.

## References

- [RFC 4867: AMR/AMR-WB RTP and storage formats](https://www.rfc-editor.org/rfc/rfc4867)
- [3GPP TS 26.445: EVS RTP formats, Annex A](https://www.etsi.org/deliver/etsi_ts/126400_126499/126445/16.03.00_60/ts_126445v160300p.pdf)
- [Official EVS source distribution](https://www.etsi.org/deliver/etsi_ts/126400_126499/126443/18.00.00_60/)
- [FFmpeg codecs](https://ffmpeg.org/general.html)
- [RFC 3711: SRTP and key derivation test vectors](https://www.rfc-editor.org/rfc/rfc3711)
