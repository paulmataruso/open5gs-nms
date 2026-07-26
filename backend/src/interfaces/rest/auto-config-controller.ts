import { Router } from 'express';
import { AutoConfigUseCase, AutoConfigInput } from '../../application/use-cases/auto-config';
import { requireAdmin } from './middleware/auth-middleware';

// Each card's fields are only required if that card's own apply toggle is on
// (all toggles default to true, matching today's "apply everything" behavior
// when a caller doesn't set them at all).
function validateInput(input: AutoConfigInput): string | null {
  const applyPlmn = input.applyPlmn ?? true;
  const applyInterfaces = input.applyInterfaces ?? true;
  const applySessionPools = input.applySessionPools ?? true;

  if (applyPlmn) {
    if (!input.plmn4g || !Array.isArray(input.plmn4g) || input.plmn4g.length === 0 || !input.plmn4g.every(p => p.mcc && p.mnc)) {
      return '4G PLMN (mcc, mnc) is required for all entries';
    }
    if (!input.plmn5g || !Array.isArray(input.plmn5g) || input.plmn5g.length === 0 || !input.plmn5g.every(p => p.mcc && p.mnc)) {
      return '5G PLMN (mcc, mnc) is required for all entries';
    }
  }

  if (applyInterfaces) {
    if ((!input.s1mmeIP && !input.s1mmeDev) || !input.sgwuGtpIP || (!input.amfNgapIP && !input.amfNgapDev) || !input.upfGtpIP) {
      return 'S1-MME (IP or interface), SGW-U GTP-U, NGAP (IP or interface), and UPF GTP-U are all required';
    }
  }

  if (applySessionPools) {
    if (!input.sessionPoolIPv4Subnet || !input.sessionPoolIPv4Gateway ||
        !input.sessionPoolIPv6Subnet || !input.sessionPoolIPv6Gateway) {
      return 'All session pool settings are required';
    }
  }

  return null;
}

export function createAutoConfigRouter(autoConfigUseCase: AutoConfigUseCase): Router {
  const router = Router();

  // POST /api/auto-config/preview - Preview auto-configuration changes (YAML diff)
  router.post('/preview', requireAdmin, async (req, res) => {
    try {
      const input: AutoConfigInput = req.body;
      const validationError = validateInput(input);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError });
      }

      const result = await autoConfigUseCase.preview(input);
      res.json(result);
    } catch (err) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
        diffs: {},
      });
    }
  });

  // POST /api/auto-config/apply - Apply auto-configuration
  router.post('/apply', requireAdmin, async (req, res) => {
    try {
      const input: AutoConfigInput = req.body;
      const validationError = validateInput(input);
      if (validationError) {
        return res.status(400).json({ success: false, message: validationError, updatedFiles: [] });
      }

      const result = await autoConfigUseCase.execute(input, 'admin');

      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : 'Unknown error',
        updatedFiles: [],
        errors: [err instanceof Error ? err.message : 'Unknown error'],
      });
    }
  });

  return router;
}
