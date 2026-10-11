// User management — users-controller.ts, mounted at /api/users, 5 routes.
// Full throwaway-account lifecycle: create -> change role -> change
// password (and confirm the new password actually works) -> delete.
import { ApiClient } from '../lib/client.mjs';
import { assertOk, assertEqual, pass, fail } from '../lib/test-case.mjs';

export const MODULE = 'users';

const TEST_USERNAME = 'api-regression-test-user';
const TEST_PASSWORD = 'ApiRegressionTest123!';
const TEST_PASSWORD_2 = 'ApiRegressionTest456!';

export const CASES = [
  {
    name: 'GET / (list users)',
    async run({ client }) {
      const res = await client.get('/api/users/');
      assertOk(res, 'GET /api/users/');
      const users = res.data?.data?.users ?? res.data?.users;
      if (!Array.isArray(users)) return fail('response missing a users array', res.data);
      return pass(`${users.length} user(s)`);
    },
  },
  {
    name: 'full lifecycle: create -> change role -> change password (confirm it works) -> delete',
    async run({ client: adminClient, revertQueue }) {
      const listRes = await adminClient.get('/api/users/');
      const users = listRes.data?.data?.users ?? listRes.data?.users;
      if (users.some(u => u.username === TEST_USERNAME)) {
        return fail(`A user named "${TEST_USERNAME}" already exists — refusing to touch it.`);
      }

      const invalidRes = await adminClient.post('/api/users/', { username: TEST_USERNAME, password: '123' });
      if (invalidRes.status !== 400) return fail(`expected HTTP 400 for a weak password, got ${invalidRes.status}`);

      const createRes = await adminClient.post('/api/users/', { username: TEST_USERNAME, password: TEST_PASSWORD, role: 'viewer' });
      assertOk(createRes, 'POST /api/users/');
      const userId = createRes.data?.data?.user?.id;
      if (!userId) return fail('create response missing data.user.id', createRes.data);
      revertQueue.push(`delete test user ${TEST_USERNAME}`, async () => {
        await adminClient.delete(`/api/users/${userId}`).catch(() => {});
      });

      const dupRes = await adminClient.post('/api/users/', { username: TEST_USERNAME, password: TEST_PASSWORD });
      if (dupRes.status !== 409) return fail(`expected HTTP 409 for a duplicate username, got ${dupRes.status}`);

      const roleRes = await adminClient.patch(`/api/users/${userId}/role`, { role: 'admin' });
      assertOk(roleRes, 'PATCH /api/users/:id/role');
      const afterRole = await adminClient.get('/api/users/');
      const afterRoleUsers = afterRole.data?.data?.users ?? afterRole.data?.users;
      assertEqual(afterRoleUsers.find(u => u.id === userId)?.role, 'admin', 'role after PATCH');

      const pwRes = await adminClient.put(`/api/users/${userId}/password`, { password: TEST_PASSWORD_2 });
      assertOk(pwRes, 'PUT /api/users/:id/password');

      // Confirm the NEW password genuinely works by logging in with it on a
      // separate session — the real functional proof, not just "the API
      // returned success".
      const testClient = new ApiClient(adminClient.baseUrl);
      await testClient.login(TEST_USERNAME, TEST_PASSWORD_2);

      const oldPwClient = new ApiClient(adminClient.baseUrl);
      let oldPasswordStillWorks = true;
      try { await oldPwClient.login(TEST_USERNAME, TEST_PASSWORD); } catch { oldPasswordStillWorks = false; }
      if (oldPasswordStillWorks) return fail('the OLD password still works after changing it');

      const delRes = await adminClient.delete(`/api/users/${userId}`);
      assertOk(delRes, 'DELETE /api/users/:id');
      const afterDelete = await adminClient.get('/api/users/');
      const afterDeleteUsers = afterDelete.data?.data?.users ?? afterDelete.data?.users;
      if (afterDeleteUsers.some(u => u.id === userId)) return fail('user still present in list after delete');

      return pass('full create->role-change->password-change(verified via real login)->delete cycle confirmed; weak password and duplicate username both correctly rejected');
    },
  },
];
