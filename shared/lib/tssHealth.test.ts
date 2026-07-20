import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {buildCombinedProcessHealth, readPairedProcessHealth, writeTssPartyHeartbeat} from './tssHealth'

function run(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-health-'))
  const heartbeatPath = path.join(root, 'heartbeat.json')
  try {
    assert.equal(readPairedProcessHealth(heartbeatPath, 2, 1_000).healthy, false)
    writeTssPartyHeartbeat(heartbeatPath, 2, new Date(10_000))
    assert.deepEqual(readPairedProcessHealth(heartbeatPath, 2, 40_000), {
      healthy: true,
      partyIndex: 2,
      lastHeartbeatAt: new Date(10_000).toISOString(),
      ageMs: 30_000,
    })
    assert.equal(readPairedProcessHealth(heartbeatPath, 2, 55_001).healthy, false)
    assert.equal(readPairedProcessHealth(heartbeatPath, 3, 40_000).healthy, false)
    const paired = readPairedProcessHealth(heartbeatPath, 2, 40_000)
    assert.equal(buildCombinedProcessHealth(true, paired).statusCode, 200)
    assert.equal(buildCombinedProcessHealth(false, paired).statusCode, 503)
    assert.equal(buildCombinedProcessHealth(true, {...paired, healthy: false}).statusCode, 503)
  } finally {
    fs.rmSync(root, {recursive: true, force: true})
  }
  console.log('tssHealth tests passed')
}

run()
