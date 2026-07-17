import { createHmac } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';

const SIMLESSLY_GENERATE_AC_URL = 'https://rsp.simlessly.com/api/v2/ac/generate';

export interface SimlesslyGenerateAcResponse {
  success: boolean;
  code: string;
  msg: string;
  obj?: {
    iccid: string;
    activationCode?: string;
    acLink?: string;
  };
}

export class EsimGeneratorUseCase {
  constructor(
    private readonly accessKey: string,
    private readonly secretKey: string,
    private readonly logger: pino.Logger,
  ) {}

  // Builds the Simlessly Signature-spec headers and calls Single Generate AC
  // (POST /api/v2/ac/generate). The signed string and the literal HTTP body
  // MUST be byte-identical — requestBody is serialized exactly once here and
  // that same string is used for both the signature and the request payload.
  async generateAc(requestBody: Record<string, unknown>): Promise<SimlesslyGenerateAcResponse> {
    if (!this.accessKey || !this.secretKey) {
      throw new Error('Simlessly credentials are not configured (SIMLESSLY_ACCESS_KEY / SIMLESSLY_SECRET_KEY)');
    }

    const bodyString = JSON.stringify(requestBody);
    const timestamp = Date.now().toString();
    const requestId = uuidv4().replace(/-/g, '');

    const signData = timestamp + requestId + this.accessKey + bodyString;
    const signature = createHmac('sha256', this.secretKey)
      .update(signData, 'utf8')
      .digest('hex')
      .toUpperCase();

    this.logger.info({ requestId, iccid: requestBody.iccid, imsi: requestBody.imsi }, 'Calling Simlessly Single Generate AC');

    let response: Response;
    try {
      response = await fetch(SIMLESSLY_GENERATE_AC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          AccessKey: this.accessKey,
          Timestamp: timestamp,
          RequestID: requestId,
          Signature: signature,
        },
        body: bodyString,
      });
    } catch (err) {
      this.logger.error({ err: String(err) }, 'Simlessly API request failed (network error)');
      throw new Error(`Failed to reach Simlessly API: ${err instanceof Error ? err.message : String(err)}`);
    }

    const text = await response.text();
    let parsed: SimlesslyGenerateAcResponse;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Simlessly API returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`);
    }

    if (!response.ok) {
      this.logger.warn({ status: response.status, parsed }, 'Simlessly API returned an error response');
    }

    return parsed;
  }
}
