/**
 * The HTML report — and the hand-off, which is the part that matters.
 *
 * A verdict list with no next step is an instrument with no output tray. This turns
 * findings into work: every STILL OPEN row is selectable, and the selection becomes either
 * prefilled GitHub issues or a `gh issue create` command to paste.
 *
 * WHY PREFILLED URLS AND NOT AN API CALL. A report is a static file, opened from disk or
 * from a CI artifact. It has no server, no token, and in most viewers no permission to
 * reach github.com at all. `…/issues/new?title=&body=&labels=` is a plain link: GitHub
 * renders the issue form already filled in, and a person presses Submit. No credential
 * ever touches the page, and the human stays in the loop by construction.
 *
 * The automated path is the CLI (`ca issues --apply`), which has a token and needs no UI.
 * Both exist on purpose: a reviewer triaging twelve findings wants to pick four; a nightly
 * job wants to file them all without asking.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

export function issueBody(f, repoName) {
    return `### ❌ ${f.stillOpen === 'OPEN' ? '🔴 Still open' : 'Finding'} — found by \`control-arm\`

The test shipped with this fix does not fail on the code it was written to catch.

| | |
|---|---|
| commit | \`${f.sha.slice(0, 8)}\` |
| date | ${f.date} |
| subject | ${f.subject} |
| verdict | \`${f.verdict}\`${f.stillOpen ? ` — \`${f.stillOpen}\`` : ''} |

### What this means

The fix changed source, and shipped a test. Replaying that test against the parent commit
(the code **with** the bug still in it) did not make it fail. So nothing in this commit
would have caught the bug it was fixing.

${f.cases?.length ? `### Cases examined\n\n${f.cases.map(c => `- \`${c.verdict}\` ${c.name}${c.why ? `\n  - ${c.why}` : ''}`).join('\n')}` : ''}

### Reproduce

\`\`\`bash
ca verify ${f.sha.slice(0, 8)} --repo ${repoName}
\`\`\`

<sub>Verdict is a measurement, not a judgement of the author — a regression guard is
indistinguishable from a weak test at this level. Confirm before acting.</sub>`;
}

export function renderHtml({ findings, meta, repoSlug = 'OWNER/REPO', repoName = '.' }) {
    const rows = findings.map((f, i) => {
        const url = `https://github.com/${repoSlug}/issues/new?title=${encodeURIComponent(`test gap: ${f.subject.slice(0, 70)}`)}&body=${encodeURIComponent(issueBody(f, repoName))}&labels=${encodeURIComponent('test-gap,needs:dev')}`;
        return `<tr data-i="${i}">
      <td><input type="checkbox" class="pick" id="p${i}" data-url="${esc(url)}" data-sha="${esc(f.sha.slice(0,8))}"></td>
      <td><code>${esc(f.sha.slice(0, 8))}</code></td>
      <td class="dt">${esc(f.date)}</td>
      <td><label for="p${i}">${esc(f.subject)}</label>
        ${f.cases?.length ? `<details><summary>${f.cases.length} cases</summary><ul>${f.cases.map(c => `<li><span class="v v-${c.verdict.toLowerCase().replace(/[^a-z]/g,'')}">${esc(c.verdict)}</span> ${esc(c.name)}${c.why ? `<div class="why">${esc(c.why)}</div>` : ''}</li>`).join('')}</ul></details>` : ''}</td>
      <td><span class="v v-${(f.stillOpen||'').toLowerCase()}">${esc(f.stillOpen || '—')}</span></td>
    </tr>`;
    }).join('\n');

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>control-arm report — ${esc(meta.repo || '')}</title>
<style>
:root{--bg:#f6f7f8;--sf:#fff;--ink:#15181c;--dim:#6d7781;--rule:#d9dde1;--ok:#1a6b45;--bad:#9a2f24;--warn:#8a5a09;--acc:#1b4f72;color-scheme:light}
@media(prefers-color-scheme:dark){:root{--bg:#101317;--sf:#171b20;--ink:#e6eaee;--dim:#848e98;--rule:#2a3138;--ok:#5cc08d;--bad:#e08279;--warn:#d7a545;--acc:#78b4dd;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
.w{max-width:1040px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:1.6rem;margin:0 0 .3rem}.sub{color:var(--dim);margin:0 0 1.6rem;font-size:.9rem}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:1.8rem}
.tile{background:var(--sf);border:1px solid var(--rule);border-radius:6px;padding:12px 14px}
.tile b{display:block;font-size:1.5rem;font-variant-numeric:tabular-nums}
.tile span{color:var(--dim);font-size:.76rem;text-transform:uppercase;letter-spacing:.06em}
table{width:100%;border-collapse:collapse;background:var(--sf);border:1px solid var(--rule);border-radius:6px;overflow:hidden}
th,td{text-align:left;padding:.6rem .7rem;border-bottom:1px solid var(--rule);vertical-align:top}
th{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
td.dt{white-space:nowrap;color:var(--dim);font-size:.85rem}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
.v{font-size:.7rem;font-weight:600;padding:.1em .45em;border-radius:3px;white-space:nowrap}
.v-caught,.v-repaired{background:color-mix(in srgb,var(--ok) 15%,transparent);color:var(--ok)}
.v-blind,.v-open{background:color-mix(in srgb,var(--bad) 15%,transparent);color:var(--bad)}
.v-inconclusive,.v-unknown,.v-nondiscriminating{background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn)}
.why{color:var(--dim);font-size:.82rem;margin:.15rem 0 .4rem 0;padding-left:.6rem;border-left:2px solid var(--rule)}
details{margin-top:.35rem}summary{cursor:pointer;color:var(--acc);font-size:.84rem}
ul{margin:.4rem 0;padding-left:1.1rem}li{margin:.25rem 0}
.bar{position:sticky;bottom:0;background:var(--sf);border-top:1px solid var(--rule);padding:12px 20px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 -20px -80px;padding-bottom:calc(12px + env(safe-area-inset-bottom,0px))}
button{font:inherit;padding:.45rem .9rem;border-radius:5px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer}
button.ghost{background:transparent;color:var(--acc)}
button:disabled{opacity:.45;cursor:not-allowed}
#cnt{color:var(--dim);font-size:.86rem}
pre{background:var(--bg);border:1px solid var(--rule);border-radius:5px;padding:.7rem;overflow-x:auto;font-size:.8rem;margin:.6rem 0 0}
</style></head><body><div class="w">
<h1>control-arm</h1>
<p class="sub">${esc(meta.repo || '')} · ${esc(meta.n)} commits sampled · seed ${esc(meta.seed)} · ${esc(meta.when)}</p>
<div class="tiles">
  <div class="tile"><b>${meta.caught}</b><span>caught</span></div>
  <div class="tile"><b>${meta.blind}</b><span>blind</span></div>
  <div class="tile"><b>${meta.inconclusive}</b><span>inconclusive</span></div>
  <div class="tile"><b>${meta.pct}%</b><span>of answerable</span></div>
</div>
<table><thead><tr><th style="width:2rem"></th><th>commit</th><th>date</th><th>fix</th><th>still open?</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5" style="color:var(--dim)">No blind findings in this sample.</td></tr>'}</tbody></table>
<pre id="cmd" hidden></pre>
<div class="bar">
  <button id="all" class="ghost">Select all</button>
  <span id="cnt">0 selected</span>
  <button id="open" disabled>Open GitHub issues</button>
  <button id="copy" class="ghost" disabled>Copy gh command</button>
</div>
</div><script>
const picks=()=>[...document.querySelectorAll('.pick:checked')];
const cnt=document.getElementById('cnt'),ob=document.getElementById('open'),cb=document.getElementById('copy'),cmd=document.getElementById('cmd');
function sync(){const n=picks().length;cnt.textContent=n+' selected';ob.disabled=cb.disabled=!n;}
document.addEventListener('change',e=>{if(e.target.classList.contains('pick'))sync()});
document.getElementById('all').onclick=()=>{const b=picks().length===0;document.querySelectorAll('.pick').forEach(c=>c.checked=b);sync()};
ob.onclick=()=>{picks().forEach((c,i)=>setTimeout(()=>window.open(c.dataset.url,'_blank','noopener'),i*260))};
cb.onclick=async()=>{const t=picks().map(c=>'ca issues '+c.dataset.sha+' --apply').join('\\n');cmd.hidden=false;cmd.textContent=t;
  try{await navigator.clipboard.writeText(t);cb.textContent='Copied'}catch{cb.textContent='Shown below'}
  setTimeout(()=>cb.textContent='Copy gh command',1800)};
sync();
</script></body></html>`;
}
