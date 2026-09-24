#!/usr/bin/env node
/**
 * The few GitHub API calls these workflows need, over plain fetch.
 *
 * WHY NOT THE `gh` CLI. It is not installed on every runner. Measured: a self-hosted
 * bare-metal runner failed with `gh: command not found` (exit 127) after every other step
 * had passed — the tool ran, reached the right verdict, and then could not say so.
 * GitHub-hosted runners ship `gh`; a self-hosted one ships whatever was installed on it,
 * and a workflow that assumes otherwise works until it lands on the wrong machine.
 *
 * Node is already a hard requirement here — the tool is written in it — so this adds no
 * dependency at all. Usage:
 *
 *   gh-api.mjs upsert-pr-comment <repo> <pr> <body-file> <marker>
 *   gh-api.mjs upsert-issue      <repo> <title> <body-file> <search> [label]
 *
 * Reads GITHUB_TOKEN / GH_TOKEN from the environment. Prints what it did, and exits
 * non-zero only when the API refuses — never merely because there was nothing to do.
 */

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
const API = process.env.GITHUB_API_URL || 'https://api.github.com';

async function gh(path, init = {}) {
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${TOKEN}`,
            accept: 'application/vnd.github+json',
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
            ...(init.headers || {}),
        },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`${init.method || 'GET'} ${path} → ${res.status} ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? null : res.json();
}

const [cmd, ...args] = process.argv.slice(2);
const read = async (f) => (await import('node:fs/promises')).readFile(f, 'utf8');

try {
    if (!TOKEN) throw new Error('no GITHUB_TOKEN / GH_TOKEN in the environment');

    if (cmd === 'upsert-pr-comment') {
        const [repo, pr, bodyFile, marker] = args;
        const body = await read(bodyFile);
        if (!body.trim()) { console.log('nothing to post'); process.exit(0); }
        // ONE COMMENT PER PR, edited in place. A new comment per push turns a useful signal
        // into noise by the third revision, and the marker is how we find ours again.
        const comments = await gh(`/repos/${repo}/issues/${pr}/comments?per_page=100`);
        const mine = comments.find(c => (c.body || '').startsWith(marker));
        if (mine) {
            await gh(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
            console.log(`updated comment ${mine.id}`);
        } else {
            const made = await gh(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
            console.log(`posted comment ${made.id}`);
        }
    } else if (cmd === 'upsert-issue') {
        const [repo, title, bodyFile, search, label] = args;
        const body = await read(bodyFile);
        if (label) {
            // Create the label if absent. `labels` on an issue with an unknown label is
            // rejected outright, so this cannot be left to chance — but a failure here is
            // a warning, not a reason to drop the finding on the floor.
            try {
                await gh(`/repos/${repo}/labels`, { method: 'POST', body: JSON.stringify({ name: label, color: '0E8A16', description: 'Test-gap findings from control-arm' }) });
            } catch (e) { if (!/already_exists|422/.test(e.message)) console.log(`::warning::could not create label ${label}: ${e.message}`); }
        }
        const found = await gh(`/search/issues?q=${encodeURIComponent(`repo:${repo} is:issue is:open ${search}`)}`);
        const hit = found.items?.[0];
        if (hit) {
            await gh(`/repos/${repo}/issues/${hit.number}`, { method: 'PATCH', body: JSON.stringify({ title, body }) });
            console.log(`refreshed issue #${hit.number}`);
        } else {
            const made = await gh(`/repos/${repo}/issues`, { method: 'POST', body: JSON.stringify({ title, body, ...(label ? { labels: [label] } : {}) }) });
            console.log(`filed issue #${made.number}`);
        }
    } else {
        console.error('usage: gh-api.mjs upsert-pr-comment|upsert-issue ...');
        process.exit(2);
    }
} catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
}
