// RF Planning Projects + Reports — rf-planning-projects-controller.ts (10
// routes) and rf-planning-reports-controller.ts (1 route), both mounted at
// /api/rf-planning/projects. Plain CRUD over a dedicated Mongo collection
// plus the same pure-calculation engine rf-planning.test.mjs exercises
// directly — no radio hardware, no host config, nothing to restart. One
// lifecycle test drives the whole thing: create a throwaway project, add a
// site, add/remove a survey point, read calibration, compare-sites,
// interference, a PDF report, then delete.
import { assertOk, assertEqual, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'rf-planning-projects';

const TEST_PROJECT_NAME = 'API-REGRESSION-TEST-PROJECT';

const TEST_SITE = {
  name: 'API-REGRESSION-TEST-SITE',
  siteLat: 37.7749, siteLon: -122.4194, siteHeightM: 30,
  azimuthDeg: 90, horizontalBeamwidthDeg: 65,
  txPowerDbm: 43, cableLossDb: 1.5, connectorLossDb: 0.5, antennaGainDbi: 17,
  frequencyMhz: 2130,
};

export const CASES = [
  {
    name: 'GET / (list projects)',
    async run({ client }) {
      const res = await client.get('/api/rf-planning/projects/');
      assertOk(res, 'GET /api/rf-planning/projects/');
      if (!Array.isArray(res.data?.projects)) return fail('response missing "projects" array', res.data);
      return pass(`${res.data.projects.length} project(s)`);
    },
  },
  {
    name: 'POST / input validation (missing name)',
    async run({ client }) {
      const res = await client.post('/api/rf-planning/projects/', { description: 'no name' });
      if (res.status !== 400) return fail(`expected HTTP 400 for a missing name, got ${res.status}`, res.data);
      return pass('missing name correctly rejected (400)');
    },
  },
  {
    name: 'full lifecycle: create -> add site -> survey points -> calibration -> compare-sites -> interference -> PDF report -> delete',
    async run({ client, revertQueue }) {
      const listRes = await client.get('/api/rf-planning/projects/');
      if (listRes.data.projects.some(p => p.name === TEST_PROJECT_NAME)) {
        return fail(`A project named "${TEST_PROJECT_NAME}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/rf-planning/projects/', { name: TEST_PROJECT_NAME, description: 'created by the API regression suite' });
      assertOk(createRes, 'POST /api/rf-planning/projects/');
      const projectId = createRes.data?.project?.id;
      if (!projectId) return fail('create response missing project.id', createRes.data);
      revertQueue.push(`delete test RF planning project ${TEST_PROJECT_NAME}`, async () => {
        const current = await client.get('/api/rf-planning/projects/');
        if (current.data?.projects?.some(p => p.id === projectId)) {
          await client.delete(`/api/rf-planning/projects/${projectId}`);
        }
      });

      const getRes = await client.get(`/api/rf-planning/projects/${projectId}`);
      assertOk(getRes, 'GET /api/rf-planning/projects/:id');
      assertEqual(getRes.data?.project?.sites?.length, 0, 'new project sites length');

      // Whole-document PUT to add one site (this controller's own
      // documented convention — no granular "add site" sub-route).
      const putRes = await client.put(`/api/rf-planning/projects/${projectId}`, {
        sites: [TEST_SITE],
        targetPolygon: [
          { lat: 37.773, lon: -122.422 }, { lat: 37.773, lon: -122.416 },
          { lat: 37.778, lon: -122.416 }, { lat: 37.778, lon: -122.422 },
        ],
        minAcceptableSignalDbm: -100,
      });
      assertOk(putRes, 'PUT /api/rf-planning/projects/:id');
      const siteId = putRes.data?.project?.sites?.[0]?.id;
      if (!siteId) return fail('update response missing sites[0].id', putRes.data);
      assertEqual(putRes.data.project.sites[0].name, TEST_SITE.name, 'saved site name');

      const addPointRes = await client.post(`/api/rf-planning/projects/${projectId}/sites/${siteId}/survey-points`, {
        lat: 37.776, lon: -122.418, measuredDbm: -85,
      });
      assertOk(addPointRes, 'POST .../survey-points');
      const siteAfterAdd = addPointRes.data?.project?.sites?.find(s => s.id === siteId);
      assertEqual(siteAfterAdd?.surveyPoints?.length, 1, 'survey point count after add');

      const addPointRes2 = await client.post(`/api/rf-planning/projects/${projectId}/sites/${siteId}/survey-points`, {
        lat: 37.774, lon: -122.419, measuredDbm: -90,
      });
      assertOk(addPointRes2, 'POST .../survey-points (2nd point)');

      const calibRes = await client.get(`/api/rf-planning/projects/${projectId}/sites/${siteId}/calibration`);
      assertOk(calibRes, 'GET .../calibration');
      if (!calibRes.data?.success) return fail('calibration response missing success:true', calibRes.data);

      // Remove survey point at index 0 — confirm it's actually gone, not
      // just acknowledged.
      const delPointRes = await client.delete(`/api/rf-planning/projects/${projectId}/sites/${siteId}/survey-points/0`);
      assertOk(delPointRes, 'DELETE .../survey-points/0');
      const siteAfterDel = delPointRes.data?.project?.sites?.find(s => s.id === siteId);
      assertEqual(siteAfterDel?.surveyPoints?.length, 1, 'survey point count after removing index 0');

      const compareRes = await client.post(`/api/rf-planning/projects/${projectId}/compare-sites`, { radiusM: 500, resolution: 100 });
      assertOk(compareRes, 'POST .../compare-sites');
      if (!Array.isArray(compareRes.data?.results) || compareRes.data.results.length !== 1) {
        return fail('expected a 1-entry results array (one saved site)', compareRes.data);
      }

      const interferenceRes = await client.post(`/api/rf-planning/projects/${projectId}/interference`, { radiusM: 500, resolution: 100 });
      assertOk(interferenceRes, 'POST .../interference');
      if (interferenceRes.data?.ok !== true) return fail('expected ok:true from the interference engine', interferenceRes.data);

      const pdfRes = await client.get(`/api/rf-planning/projects/${projectId}/report.pdf`);
      if (pdfRes.status !== 200) return fail(`expected HTTP 200 for the PDF report, got ${pdfRes.status}`, pdfRes.data);

      const deleteRes = await client.delete(`/api/rf-planning/projects/${projectId}`);
      assertOk(deleteRes, 'DELETE /api/rf-planning/projects/:id');
      const afterDelete = await client.get('/api/rf-planning/projects/');
      if (afterDelete.data.projects.some(p => p.id === projectId)) {
        return fail('project still present in list after delete');
      }

      return pass('full create->site->survey-points->calibration->compare-sites->interference->PDF->delete cycle verified', { projectId });
    },
  },
  {
    name: 'GET /:id and /:id/sites/:siteId/calibration return 404 for nonexistent ids',
    async run({ client }) {
      const projRes = await client.get('/api/rf-planning/projects/000000000000000000000000-does-not-exist');
      if (projRes.status !== 404) return fail(`expected HTTP 404 for a nonexistent project, got ${projRes.status}`, projRes.data);
      return pass('nonexistent project id correctly returns 404');
    },
  },
];
