// Subscriber Groups — full CRUD lifecycle, plus a real regression test for
// a documented historical bug: subscriber-groups-controller.ts's own header
// comment records that as of 2026-09-30 a real viewer-role account could
// fully create/update/delete groups (the 3 mutating routes were missing
// requireAdmin, unlike every sibling module). The code now has requireAdmin
// on all three — this module directly tests that a viewer account gets 403
// on each, so if that regresses, this suite catches it rather than relying
// on the fix never being touched again.
import { ApiClient } from '../lib/client.mjs';
import { assertOk, assertEqual, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'subscriber-groups';

const TEST_GROUP_NAME = 'API-REGRESSION-TEST-GROUP';
const TEST_VIEWER_USERNAME = 'api-regression-test-viewer';
const TEST_VIEWER_PASSWORD = 'ApiRegressionTest123!';

export const CASES = [
  {
    name: 'GET / (list groups)',
    async run({ client }) {
      const res = await client.get('/api/subscriber-groups/');
      assertOk(res, 'GET /api/subscriber-groups/');
      if (!Array.isArray(res.data?.data)) return fail('response missing "data" array', res.data);
      return pass(`${res.data.data.length} group(s)`);
    },
  },
  {
    name: 'full lifecycle: create -> edit -> delete',
    async run({ client, revertQueue }) {
      const listRes = await client.get('/api/subscriber-groups/');
      assertOk(listRes, 'GET /api/subscriber-groups/ (pre-check)');
      if (listRes.data.data.some(g => g.name === TEST_GROUP_NAME)) {
        return fail(`A group named "${TEST_GROUP_NAME}" already exists — refusing to touch it.`);
      }

      const createRes = await client.post('/api/subscriber-groups/', {
        name: TEST_GROUP_NAME, imsis: [], color: '#ff00ff',
      });
      assertOk(createRes, 'POST /api/subscriber-groups/');
      const groupId = createRes.data?.data?._id;
      if (!groupId) return fail('create response missing group _id', createRes.data);
      revertQueue.push(`delete test group ${TEST_GROUP_NAME}`, async () => {
        const current = await client.get('/api/subscriber-groups/');
        if (current.data?.data?.some(g => g._id === groupId)) {
          await client.delete(`/api/subscriber-groups/${groupId}`);
        }
      });

      const afterCreate = await client.get('/api/subscriber-groups/');
      const created = afterCreate.data.data.find(g => g._id === groupId);
      if (!created) return fail('created group not found in subsequent list');
      assertEqual(created.color, '#ff00ff', 'created group color');
      assertEqual(created.imsis?.length, 0, 'created group imsis');

      const editRes = await client.put(`/api/subscriber-groups/${groupId}`, {
        name: TEST_GROUP_NAME, imsis: ['001010000000001'], color: '#00ff00',
      });
      assertOk(editRes, 'PUT /api/subscriber-groups/:id');
      const afterEdit = await client.get('/api/subscriber-groups/');
      const edited = afterEdit.data.data.find(g => g._id === groupId);
      assertEqual(edited?.color, '#00ff00', 'edited group color');
      assertEqual(edited?.imsis?.[0], '001010000000001', 'edited group imsis');

      const delRes = await client.delete(`/api/subscriber-groups/${groupId}`);
      assertOk(delRes, 'DELETE /api/subscriber-groups/:id');
      const afterDelete = await client.get('/api/subscriber-groups/');
      if (afterDelete.data.data.some(g => g._id === groupId)) {
        return fail('group still present in list after delete');
      }

      return pass('full create->edit->delete cycle verified', { groupId });
    },
  },
  {
    // Regression test for the documented 2026-09-30 permission bug.
    name: 'viewer role is refused on all 3 mutating routes (regression test for a real, documented 2026-09-30 bug)',
    async run({ client: adminClient, revertQueue }) {
      // Create a throwaway viewer account via the admin session.
      const listUsersRes = await adminClient.get('/api/users/');
      if ((listUsersRes.data?.data?.users ?? []).some(u => u.username === TEST_VIEWER_USERNAME)) {
        return fail(`A user named "${TEST_VIEWER_USERNAME}" already exists — refusing to touch it.`);
      }
      const createUserRes = await adminClient.post('/api/users/', {
        username: TEST_VIEWER_USERNAME, password: TEST_VIEWER_PASSWORD, role: 'viewer',
      });
      if (!createUserRes.ok) {
        return fail(`could not create a throwaway viewer account for this test: HTTP ${createUserRes.status} — ${JSON.stringify(createUserRes.data)}`);
      }
      const viewerId = createUserRes.data?.data?.user?.id;
      revertQueue.push(`delete test viewer account ${TEST_VIEWER_USERNAME}`, async () => {
        if (viewerId) await adminClient.delete(`/api/users/${viewerId}`);
      });

      // Log in as the viewer on a SEPARATE client/session.
      const viewerClient = new ApiClient(adminClient.baseUrl);
      await viewerClient.login(TEST_VIEWER_USERNAME, TEST_VIEWER_PASSWORD);

      const createAttempt = await viewerClient.post('/api/subscriber-groups/', { name: 'should-not-be-created', imsis: [] });
      const editAttempt = await viewerClient.put('/api/subscriber-groups/000000000000000000000000', { name: 'x', imsis: [] });
      const deleteAttempt = await viewerClient.delete('/api/subscriber-groups/000000000000000000000000');

      const problems = [];
      if (createAttempt.status !== 403) problems.push(`POST as viewer returned HTTP ${createAttempt.status}, expected 403`);
      if (editAttempt.status !== 403) problems.push(`PUT as viewer returned HTTP ${editAttempt.status}, expected 403`);
      if (deleteAttempt.status !== 403) problems.push(`DELETE as viewer returned HTTP ${deleteAttempt.status}, expected 403`);

      // Confirm the create attempt genuinely didn't create anything despite
      // whatever status it returned.
      const listRes = await adminClient.get('/api/subscriber-groups/');
      if (listRes.data?.data?.some(g => g.name === 'should-not-be-created')) {
        problems.push('a group was actually created by the viewer-role request despite its response status — worse than just a wrong status code');
      }

      if (problems.length > 0) {
        return fail(problems.join('; '));
      }
      return pass('viewer correctly refused (403) on create, edit, and delete');
    },
  },
];
