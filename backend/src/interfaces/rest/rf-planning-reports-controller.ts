import { Router, Request, Response } from 'express';
import pino from 'pino';
import PDFDocument from 'pdfkit';
import { IRfPlanningProjectRepository } from '../../domain/interfaces/rf-planning-project-repository';
import {
  calculateLinkBudget, calculateCoverageGrid, calculateCalibrationOffset, resolveSite, Assumption,
  LinkBudgetInput, CoverageGridInput,
} from '../../domain/rf';

const REFERENCE_DISTANCE_M = 1000;

// The report is data/tables/numbers, deliberately NOT a rendered heatmap
// raster image — embedding the actual map would need server-side canvas
// rendering (the `canvas` npm package, native bindings, heavier Docker
// image) or a headless-browser screenshot pipeline, a meaningfully bigger
// lift than the rest of this feature. Flagged here explicitly rather than
// silently shipped at lower fidelity than the rest of this tool.
export function createRfPlanningReportsRouter(repo: IRfPlanningProjectRepository, logger: pino.Logger): Router {
  const router = Router();

  router.get('/:id/report.pdf', async (req: Request, res: Response) => {
    try {
      const project = await repo.findById(req.params.id);
      if (!project) { res.status(404).json({ success: false, error: 'Project not found' }); return; }

      const doc = new PDFDocument({ margin: 50 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${project.name.replace(/[^a-z0-9]+/gi, '_')}-report.pdf"`);
      doc.pipe(res);

      doc.fontSize(20).text(project.name, { underline: true });
      if (project.description) doc.fontSize(11).fillColor('gray').text(project.description);
      doc.fillColor('black').fontSize(9).text(`Generated ${new Date().toISOString()}`);
      doc.moveDown();
      if (project.sites.length === 0) {
        doc.fontSize(11).text('This project has no saved sites yet.');
      }

      for (const site of project.sites) {
        doc.addPage();
        doc.fontSize(16).text(site.name);
        doc.moveDown(0.5);

        doc.fontSize(10);
        const configRows: [string, string][] = [
          ['Location', `${site.siteLat.toFixed(5)}, ${site.siteLon.toFixed(5)}`],
          ['Site Height', `${site.siteHeightM} m`],
          ['Azimuth', `${site.azimuthDeg}°`],
          ['Horizontal Beamwidth', `${site.horizontalBeamwidthDeg}°`],
          ['TX Power', `${site.txPowerDbm} dBm`],
          ['Antenna Gain', `${site.antennaGainDbi} dBi`],
          ['Frequency', site.frequencyMhz ? `${site.frequencyMhz} MHz` : (site.band != null ? `Band ${site.band}, EARFCN ${site.earfcn}` : 'n/a')],
          ['Propagation Model', site.propagationModel ?? 'fspl'],
          ['Terrain-Aware', site.useTerrainData ? 'Yes' : 'No'],
        ];
        for (const [k, v] of configRows) doc.text(`${k}: ${v}`);
        doc.moveDown();

        const linkInput: LinkBudgetInput = {
          txPowerDbm: site.txPowerDbm, cableLossDb: site.cableLossDb, connectorLossDb: site.connectorLossDb,
          filterLossDb: site.filterLossDb, antennaGainDbi: site.antennaGainDbi,
          frequencyMhz: site.frequencyMhz, band: site.band, earfcn: site.earfcn,
          distanceM: REFERENCE_DISTANCE_M,
          buildingLossDb: site.buildingLossDb, foliageLossDb: site.foliageLossDb, miscLossDb: site.miscLossDb,
          ueAntennaGainDbi: site.ueAntennaGainDbi,
        };
        const linkResult = calculateLinkBudget(linkInput);
        doc.fontSize(12).text(`Representative Link Budget @ ${REFERENCE_DISTANCE_M}m`, { underline: true });
        doc.fontSize(10);
        if (linkResult.ok && linkResult.result) {
          doc.text(`EIRP: ${linkResult.result.eirpDbm.toFixed(2)} dBm`);
          doc.text(`Path Loss: ${linkResult.result.pathLossDb.toFixed(2)} dB`);
          doc.text(`Predicted Received Power: ${linkResult.result.totalReceivedPowerDbm.toFixed(2)} dBm`);
          doc.moveDown(0.5);
          doc.fontSize(9).fillColor('gray').text('Equation Sources:');
          for (const eq of linkResult.calculation) doc.text(`- ${eq.name}: ${eq.formula} (${eq.source})`);
          doc.fillColor('black');
        } else {
          doc.fillColor('red').text(`Could not compute: ${linkResult.error?.reason}`);
          doc.fillColor('black');
        }
        doc.moveDown();

        if (site.surveyPoints && site.surveyPoints.length > 0) {
          const assumptions: Assumption[] = [];
          const resolved = resolveSite(site, assumptions);
          doc.fontSize(12).text('Field-Survey Calibration', { underline: true });
          doc.fontSize(10);
          if ('params' in resolved) {
            const calibration = await calculateCalibrationOffset(site.surveyPoints, resolved.params, logger);
            if (calibration) {
              doc.text(`Survey Points: ${calibration.pointCount} used, ${calibration.skippedCount} skipped (out of the propagation model's valid range)`);
              doc.text(`Calibration Offset: ${calibration.offsetDb.toFixed(2)} dB (mean of measured − predicted across survey points)`);
              doc.text(`Mean Absolute Error (uncalibrated): ${calibration.meanAbsErrorDb.toFixed(2)} dB`);
            } else {
              doc.text('No survey points could be evaluated (all fell outside the propagation model\'s valid range).');
            }
          } else {
            doc.fillColor('red').text(`Could not resolve site for calibration: ${resolved.error}`);
            doc.fillColor('black');
          }
          doc.moveDown();
        }
      }

      if (project.targetPolygon && project.targetPolygon.length >= 3 && project.minAcceptableSignalDbm != null && project.sites.length > 0) {
        doc.addPage();
        doc.fontSize(16).text('Site Comparison Against Target Coverage Area');
        doc.fontSize(10).fillColor('gray').text(`Threshold: ${project.minAcceptableSignalDbm} dBm`);
        doc.fillColor('black').moveDown();
        for (const site of project.sites) {
          const input: CoverageGridInput = { ...site, radiusM: 5000, resolution: 40, targetPolygon: project.targetPolygon, minAcceptableSignalDbm: project.minAcceptableSignalDbm };
          const result = await calculateCoverageGrid(input, logger);
          doc.fontSize(11).text(site.name);
          doc.fontSize(10);
          if (result.ok && result.result?.coverageRequirement) {
            doc.text(`Required TX Power: ${result.result.coverageRequirement.requiredTxPowerDbm.toFixed(2)} dBm`);
          } else {
            doc.fillColor('red').text(result.ok ? 'No coverage requirement computed (target area may fall outside the sampled grid)' : (result.error?.reason ?? 'Unknown error'));
            doc.fillColor('black');
          }
          doc.moveDown(0.5);
        }
      }

      doc.end();
    } catch (err) {
      logger.error({ err: String(err) }, 'rf-planning-reports: report generation failed');
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: 'Failed to generate report' });
      } else {
        res.end();
      }
    }
  });

  return router;
}
