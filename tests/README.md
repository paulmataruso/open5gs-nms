# open5gs-nms Tests

Manual test scripts for verifying critical logic. No test framework required — just Node.js.

---

## Running Tests

### Option A — Inside the backend container (recommended, no install needed)

```bash
# From the server, the backend container already has Node + ts-node + js-yaml
docker exec open5gs-nms-backend sh -c "cd /app && ./node_modules/.bin/ts-node /tests/yaml-round-trip.test.ts"
```

### Option B — On the host (requires Node.js)

```bash
# Install Node if not already present
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# From the project root
cd tests
npm install --save-dev ts-node typescript js-yaml @types/js-yaml
npx ts-node yaml-round-trip.test.ts
```

### Option C — Using the run script

```bash
# From project root
chmod +x tests/run-tests.sh
./tests/run-tests.sh
```

---

## Test Files

| File | What it tests |
|---|---|
| `yaml-round-trip.test.ts` | `deepMerge` logic and YAML round-trip safety — ensures manual edits to Open5GS YAML files are preserved when the NMS saves config changes |

---

## Adding New Tests

Add new `.test.ts` files to this folder. Follow the same pattern:
- Use the `assert(condition, label)` helper
- Call `section('name')` to group related tests
- Exit with `process.exit(1)` on failure so CI can detect failures

---

## Expected Output

```
── deepMerge: basic scalar overlay ──
  ✓ base key preserved when not in overlay
  ✓ overlay value wins on conflict

── deepMerge: nested object merge ──
  ✓ nested sibling key preserved (dev: eth0)
  ...

──────────────────────────────────────────────────
Results: 30 passed, 0 failed

✅ All tests passed
```
