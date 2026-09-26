/**
 * The largest remaining reason arm B cannot answer, said in words.
 *
 * Measured over 300 auctionmate fix commits: 21 of the 82 unanswerable ones — 26% — failed
 * because the test imports a symbol the commit ADDED to a file it already had. At the parent
 * the module graph will not link, and every case in the file dies with
 * `does not provide an export named 'X'`.
 *
 * Those files are deliberately NOT transplanted: a modified file carries the repair, so
 * handing it to arm B would hand it the fix. What can be done honestly is name the category.
 * "The test imports something this commit introduced, so it could not have existed at the
 * parent" is a finding; a SyntaxError is a stack trace.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exportsAddedToExistingFiles, missingExportName } from '../src/verify.mjs';

describe('naming the symbol an arm B link failure is about', () => {
    test('finds exports ADDED by a diff, in every declaration form', () => {
        const diff = [
            '+export function sellerPillModel(data) {',
            '+export const CANON = (s) => s;',
            '+export async function fetchThing() {',
            '+export class Widget {',
            '+export let counter = 0;',
            '+export { alpha, beta as gamma };',
        ].join('\n');
        const got = exportsAddedToExistingFiles(diff);
        for (const n of ['sellerPillModel', 'CANON', 'fetchThing', 'Widget', 'counter', 'alpha', 'gamma']) {
            assert.ok(got.has(n), `missed ${n}`);
        }
    });

    test('CONTROL ARM — a REMOVED or unchanged export is not an added one', () => {
        // Without this, the set could be "every export in the file" and the reason would be
        // attached to failures it does not explain.
        const diff = [
            '-export function goneAway() {',
            ' export function untouched() {',
            '+    const notAnExport = 1;',
            '+// export function commentedOut() {',
        ].join('\n');
        const got = exportsAddedToExistingFiles(diff);
        assert.equal(got.has('goneAway'), false, 'a deleted export is not added');
        assert.equal(got.has('untouched'), false, 'an unchanged export is not added');
        assert.equal(got.has('notAnExport'), false);
        assert.equal(got.size, 0, `expected nothing, got ${[...got].join(', ')}`);
    });

    test('reads the symbol out of the real V8 message, and is silent otherwise', () => {
        // TEST-002 — the exact name, not "it matched something".
        assert.equal(
            missingExportName("SyntaxError: The requested module '../packages/core/src/damage.js' does not provide an export named 'repairRowBranch'"),
            'repairRowBranch',
        );
        assert.equal(missingExportName('does not provide an export named "sellerPillModel"'), 'sellerPillModel');
        // Anything else must return null, or a generic failure would be mislabelled as this
        // category — the reason would then be confidently wrong instead of merely vague.
        for (const other of ['ERR_MODULE_NOT_FOUND', 'Cannot find package', '', null, undefined,
                             'Failed to resolve import "../x" from "y". Does the file exist?']) {
            assert.equal(missingExportName(other), null, `should not have matched: ${other}`);
        }
    });
});
