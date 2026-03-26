import { Router } from 'express';
import { AutoConfigUseCase, AutoConfigInput } from '../../application/use-cases/auto-config';

export function createAutoConfigRouter(autoConfigUseCase: AutoConfigUseCase): Router {
  const router = Router();

  // POST /api/auto-config/preview - Preview auto-configuration changes (YAML diff)
  router.post('/preview', async (req, res) => {
    try {
      const input: AutoConfigInput = req.body;

      // Validate required fields
      if (!input.plmn4g || !Array.isArray(input.plmn4g) || input.plmn4g.length === 0 || !input.plmn4g.every(p => p.mcc && p.mnc)) {
        return res.status(400).json({
          success: false,
          message: '4G PLMN (mcc, mnc) is required for all entries',
        });
      }

      if (!input.plmn5g || !Array.isArray(input.plmn5g) || input.plmn5g.length === 0 || !input.plmn5g.every(p => p.mcc && p.mnc)) {
        return res.status(400).json({
          success: false,
          message: '5G PLMN (mcc, mnc) is required for all entries',
        });
      }

      if (!input.s1mmeIP || !input.sgwuGtpIP || !input.amfNgapIP || !input.upfGtpIP) {
        return res.status(400).json({
          success: false,
          message: 'All IP addresses are required',
        });
      }

      if (!input.sessionPoolIPv4Subnet || !input.sessionPoolIPv4Gateway ||
          !input.sessionPoolIPv6Subnet || !input.sessionPoolIPv6Gateway) {
        return res.status(400).json({
          success: false,
          message: 'All session pool settings are required',
        });
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
  router.post('/apply', async (req, res) => {
    try {
      const input: AutoConfigInput = req.body;

      // Validate required fields
      if (!input.plmn4g || !Array.isArray(input.plmn4g) || input.plmn4g.length === 0 || !input.plmn4g.every(p => p.mcc && p.mnc)) {
        return res.status(400).json({
          success: false,
          message: '4G PLMN (mcc, mnc) is required for all entries',
          updatedFiles: [],
        });
      }

      if (!input.plmn5g || !Array.isArray(input.plmn5g) || input.plmn5g.length === 0 || !input.plmn5g.every(p => p.mcc && p.mnc)) {
        return res.status(400).json({
          success: false,
          message: '5G PLMN (mcc, mnc) is required for all entries',
          updatedFiles: [],
        });
      }

      if (!input.s1mmeIP || !input.sgwuGtpIP || !input.amfNgapIP || !input.upfGtpIP) {
        return res.status(400).json({
          success: false,
          message: 'All IP addresses are required',
          updatedFiles: [],
        });
      }

      if (!input.sessionPoolIPv4Subnet || !input.sessionPoolIPv4Gateway ||
          !input.sessionPoolIPv6Subnet || !input.sessionPoolIPv6Gateway) {
        return res.status(400).json({
          success: false,
          message: 'All session pool settings are required',
          updatedFiles: [],
        });
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
