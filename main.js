const DEFAULT_PAC = `function FindProxyForURL(url, host) {
  if (dnsDomainIs(host, ".internal.example.com")) {
    return "DIRECT";
  }

  if (shExpMatch(url, "*://*.intranet/*")) {
    return "PROXY intranet-proxy.example.com:8080";
  }

  if (isPlainHostName(host)) {
    return "DIRECT";
  }

  return "PROXY proxy.example.com:8080; DIRECT";
}`;

const app = document.getElementById("app");

const state = {
  pacSource: DEFAULT_PAC,
  pacUrl: "",
  testUrl: "https://www.example.com",
  result: "",
  error: "",
  analysis: null,
  trace: [],
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function compactText(text, limit = 140) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

function skipWhitespaceAndComments(source, start) {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      i += 2;
      while (i < source.length && !source.startsWith("*/", i)) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

function readBalanced(source, start, openChar, closeChar) {
  if (source[start] !== openChar) {
    throw new Error(`Expected '${openChar}' at index ${start}.`);
  }
  let i = start + 1;
  let depth = 1;
  let quote = "";
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      i += 2;
      while (i < source.length && !source.startsWith("*/", i)) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) depth -= 1;
    i += 1;
    if (depth === 0) {
      return {
        content: source.slice(start + 1, i - 1),
        end: i,
      };
    }
  }
  throw new Error(`Unbalanced '${openChar}${closeChar}' block.`);
}

function findStatementEnd(source, start) {
  let i = start;
  let quote = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;

  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      i += 2;
      while (i < source.length && !source.startsWith("*/", i)) i += 1;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth -= 1;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") {
      if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
        return i;
      }
      braceDepth -= 1;
    } else if (ch === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      return i + 1;
    }

    i += 1;
  }

  return source.length;
}

function extractFindProxyForURL(source) {
  const fnStart = source.search(/function\s+FindProxyForURL\s*\(/);
  if (fnStart < 0) {
    throw new Error("Could not find a FindProxyForURL function.");
  }

  const paramsStart = source.indexOf("(", fnStart);
  const paramsPart = readBalanced(source, paramsStart, "(", ")");
  const bodyStart = skipWhitespaceAndComments(source, paramsPart.end);
  if (source[bodyStart] !== "{") {
    throw new Error("Could not parse FindProxyForURL body.");
  }
  const bodyPart = readBalanced(source, bodyStart, "{", "}");

  return {
    params: paramsPart.content,
    body: bodyPart.content,
  };
}

function parseStatements(source, start = 0, stop = source.length, ctx = { ifCount: 0 }) {
  const statements = [];
  let i = start;

  while (i < stop) {
    i = skipWhitespaceAndComments(source, i);
    if (i >= stop) break;

    if (source.startsWith("if", i) && !/[A-Za-z0-9_$]/.test(source[i + 2] || "")) {
      const parsedIf = parseIfStatement(source, i, ctx);
      statements.push(parsedIf.node);
      i = parsedIf.end;
      continue;
    }

    if (source[i] === "{") {
      const block = readBalanced(source, i, "{", "}");
      const nested = parseStatements(block.content, 0, block.content.length, ctx);
      statements.push(...nested);
      i = block.end;
      continue;
    }

    const stmtEnd = Math.min(findStatementEnd(source, i), stop);
    const raw = source.slice(i, stmtEnd).trim();
    if (raw) {
      if (/^return\b/.test(raw)) {
        const expression = raw.replace(/^return\s+/, "").replace(/;\s*$/, "").trim();
        statements.push({
          type: "return",
          expression,
          raw,
        });
      } else {
        statements.push({
          type: "statement",
          raw,
        });
      }
    }

    i = stmtEnd;
    if (source[i] === "}") break;
  }

  return statements;
}

function parseIfStatement(source, start, ctx) {
  let i = start + 2;
  i = skipWhitespaceAndComments(source, i);
  if (source[i] !== "(") {
    throw new Error("Malformed if statement: missing condition.");
  }

  const cond = readBalanced(source, i, "(", ")");
  i = skipWhitespaceAndComments(source, cond.end);
  if (source[i] !== "{") {
    throw new Error("Malformed if statement: expected block body.");
  }

  const thenBlock = readBalanced(source, i, "{", "}");
  const thenStatements = parseStatements(thenBlock.content, 0, thenBlock.content.length, ctx);

  i = skipWhitespaceAndComments(source, thenBlock.end);
  let elseStatements = [];
  if (source.startsWith("else", i) && !/[A-Za-z0-9_$]/.test(source[i + 4] || "")) {
    i += 4;
    i = skipWhitespaceAndComments(source, i);
    if (source.startsWith("if", i) && !/[A-Za-z0-9_$]/.test(source[i + 2] || "")) {
      const nestedIf = parseIfStatement(source, i, ctx);
      elseStatements = [nestedIf.node];
      i = nestedIf.end;
    } else if (source[i] === "{") {
      const elseBlock = readBalanced(source, i, "{", "}");
      elseStatements = parseStatements(elseBlock.content, 0, elseBlock.content.length, ctx);
      i = elseBlock.end;
    } else {
      throw new Error("Malformed else block.");
    }
  }

  const node = {
    type: "if",
    id: `if_${++ctx.ifCount}`,
    condition: cond.content.trim(),
    then: thenStatements,
    else: elseStatements,
  };

  return { node, end: i };
}

function createRuntime() {
  return {
    dnsDomainIs(host, domain) {
      return host.endsWith(domain);
    },
    shExpMatch(str, shexp) {
      const pattern = "^" + shexp
        .replaceAll(".", "\\.")
        .replaceAll("*", ".*")
        .replaceAll("?", ".") + "$";
      return new RegExp(pattern).test(str);
    },
    isPlainHostName(host) {
      return !host.includes(".");
    },
    dnsResolve() {
      return "127.0.0.1";
    },
    myIpAddress() {
      return "127.0.0.1";
    },
  };
}

function evaluatePac(source, testUrl) {
  const host = new URL(testUrl).hostname;
  const runtime = createRuntime();
  const sandbox = new Function(
    ...Object.keys(runtime),
    "url",
    "host",
    `${source}; return FindProxyForURL(url, host);`
  );
  return sandbox(...Object.values(runtime), testUrl, host);
}

function evaluateExpression(expression, context) {
  const keys = Object.keys(context);
  const fn = new Function(...keys, `return (${expression});`);
  return fn(...Object.values(context));
}

function traceExecution(statements, context, trace, depth = 0) {
  for (const node of statements) {
    if (node.type === "if") {
      let decision = false;
      try {
        decision = Boolean(evaluateExpression(node.condition, context));
      } catch (error) {
        trace.push({
          type: "if-error",
          id: node.id,
          depth,
          condition: node.condition,
          error: error.message,
        });
        throw error;
      }

      trace.push({
        type: "if",
        id: node.id,
        depth,
        condition: node.condition,
        decision,
      });

      const branch = decision ? node.then : node.else;
      const nested = traceExecution(branch, context, trace, depth + 1);
      if (nested.returned) return nested;
      continue;
    }

    if (node.type === "return") {
      let value;
      try {
        value = evaluateExpression(node.expression, context);
      } catch {
        value = node.expression;
      }
      trace.push({
        type: "return",
        depth,
        expression: node.expression,
        value,
      });
      return { returned: true, value };
    }
  }

  return { returned: false, value: undefined };
}

function collectIfInsights(statements) {
  const rows = [];

  function helperCalls(condition) {
    const matches = condition.match(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g) || [];
    return matches.map((token) => token.replace(/\s*\($/, ""));
  }

  function collectReturns(nodes, out) {
    for (const node of nodes) {
      if (node.type === "return") {
        out.push(node.expression);
      } else if (node.type === "if") {
        collectReturns(node.then, out);
        collectReturns(node.else, out);
      }
    }
  }

  function walk(nodes, depth) {
    for (const node of nodes) {
      if (node.type !== "if") continue;
      const thenReturns = [];
      const elseReturns = [];
      collectReturns(node.then, thenReturns);
      collectReturns(node.else, elseReturns);

      rows.push({
        id: node.id,
        depth,
        condition: node.condition,
        helperCalls: helperCalls(node.condition),
        thenReturns,
        elseReturns,
      });

      walk(node.then, depth + 1);
      walk(node.else, depth + 1);
    }
  }

  walk(statements, 1);
  return rows;
}

function collectReturnExpressions(statements, out = []) {
  for (const node of statements) {
    if (node.type === "return") {
      out.push(node.expression);
    }
    if (node.type === "if") {
      collectReturnExpressions(node.then, out);
      collectReturnExpressions(node.else, out);
    }
  }
  return out;
}

function renderFlowNodes(nodes, depth = 0) {
  if (!nodes.length) {
    return `<div class="flow-empty" style="margin-left:${depth * 16}px;">(no statements)</div>`;
  }
  return nodes.map((node) => {
    if (node.type === "if") {
      return `
        <div class="flow-node" style="margin-left:${depth * 16}px;">
          <div class="flow-kind">if</div>
          <div class="flow-text"><code>${escapeHtml(compactText(node.condition, 120))}</code></div>
          <div class="flow-branch">
            <div class="flow-branch-label ok">true</div>
            ${renderFlowNodes(node.then, depth + 1)}
          </div>
          <div class="flow-branch">
            <div class="flow-branch-label muted">false</div>
            ${renderFlowNodes(node.else, depth + 1)}
          </div>
        </div>
      `;
    }
    if (node.type === "return") {
      return `
        <div class="flow-node flow-return" style="margin-left:${depth * 16}px;">
          <div class="flow-kind">return</div>
          <div class="flow-text">${escapeHtml(compactText(node.expression, 120))}</div>
        </div>
      `;
    }
    return `
      <div class="flow-node" style="margin-left:${depth * 16}px;">
        <div class="flow-kind">statement</div>
        <div class="flow-text">${escapeHtml(compactText(node.raw, 120))}</div>
      </div>
    `;
  }).join("\n");
}

function buildFlowSummary(statements) {
  return `
    <div class="flow-root">
      <div class="flow-head">FindProxyForURL(url, host)</div>
      ${renderFlowNodes(statements)}
    </div>
  `;
}

function analyzePac(source) {
  const fn = extractFindProxyForURL(source);
  const statements = parseStatements(fn.body);
  const ifRows = collectIfInsights(statements);
  const returnExpressions = collectReturnExpressions(statements);
  const maxDepth = ifRows.reduce((max, row) => Math.max(max, row.depth), 0);
  const helperUsage = {};

  for (const row of ifRows) {
    for (const helper of row.helperCalls) {
      helperUsage[helper] = (helperUsage[helper] || 0) + 1;
    }
  }

  return {
    fn,
    statements,
    ifRows,
    returnExpressions,
    maxDepth,
    helperUsage,
    flowHtml: buildFlowSummary(statements),
  };
}

function renderIfRows(ifRows) {
  if (!ifRows.length) {
    return `<div class="muted">No <code>if</code> blocks were found in FindProxyForURL.</div>`;
  }

  const rows = ifRows.map((row) => {
    const helpers = row.helperCalls.length ? row.helperCalls.join(", ") : "-";
    const thenOut = row.thenReturns.length ? row.thenReturns.join(" | ") : "(no direct return)";
    const elseOut = row.elseReturns.length ? row.elseReturns.join(" | ") : "(fallthrough/no return)";
    return `
      <tr>
        <td>${escapeHtml(row.id)}</td>
        <td>${row.depth}</td>
        <td><code>${escapeHtml(compactText(row.condition, 120))}</code></td>
        <td>${escapeHtml(helpers)}</td>
        <td>${escapeHtml(compactText(thenOut, 80))}</td>
        <td>${escapeHtml(compactText(elseOut, 80))}</td>
      </tr>
    `;
  }).join("\n");

  return `
    <div style="overflow:auto;">
      <table class="insight-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Depth</th>
            <th>Condition</th>
            <th>Helpers</th>
            <th>True path</th>
            <th>False path</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderTrace(trace) {
  if (!trace.length) {
    return `<div class="muted">Evaluate a URL to see which branches were taken.</div>`;
  }

  return trace.map((step) => {
    const indent = "&nbsp;".repeat(step.depth * 4);
    if (step.type === "if") {
      return `<div class="trace-line">${indent}<strong>${escapeHtml(step.id)}</strong> ${escapeHtml(step.condition)} => <span class="${step.decision ? "ok" : "muted"}">${step.decision}</span></div>`;
    }
    if (step.type === "return") {
      return `<div class="trace-line">${indent}<strong>return</strong> ${escapeHtml(step.expression)} => <span class="ok">${escapeHtml(step.value)}</span></div>`;
    }
    return `<div class="trace-line error">${indent}${escapeHtml(step.error || "Trace error")}</div>`;
  }).join("\n");
}

function render() {
  const analysis = state.analysis;
  const helperStats = analysis ? Object.entries(analysis.helperUsage).sort((a, b) => b[1] - a[1]) : [];

  app.innerHTML = `
    <h1>PAC Validator</h1>
    <p class="muted">Analyze every <code>if</code> block in <code>FindProxyForURL</code>, inspect branch outcomes, and see a visual decision graph plus runtime trace.</p>

    <div class="grid">
      <div class="card spaced">
        <h2>PAC Source</h2>
        <label for="pacUrl">PAC URL</label>
        <div class="actions">
          <input id="pacUrl" placeholder="https://example.com/proxy.pac" value="${escapeHtml(state.pacUrl)}" />
          <button id="loadUrl">Load URL</button>
        </div>

        <label for="pacSource">PAC Source</label>
        <textarea id="pacSource">${escapeHtml(state.pacSource)}</textarea>
        <div class="actions">
          <button id="analyze">Analyze PAC</button>
          <button id="reset" class="secondary">Reset sample</button>
        </div>
      </div>

      <div class="card spaced">
        <h2>Evaluate URL</h2>
        <label for="testUrl">URL to test</label>
        <input id="testUrl" value="${escapeHtml(state.testUrl)}" />
        <button id="evaluate">Evaluate proxy + trace</button>
        <div>
          <h3>Result</h3>
          <pre id="result">${escapeHtml(state.result || "Run analysis or evaluation to see output.")}</pre>
        </div>
        ${state.error ? `<div class="error"><strong>Error:</strong> ${escapeHtml(state.error)}</div>` : ""}
      </div>
    </div>

    <div class="grid" style="margin-top:16px;">
      <div class="card spaced">
        <h2>Insights</h2>
        ${analysis ? `
          <div class="insight-cards">
            <div><span class="muted">If blocks</span><strong>${analysis.ifRows.length}</strong></div>
            <div><span class="muted">Max depth</span><strong>${analysis.maxDepth || 0}</strong></div>
            <div><span class="muted">Return paths</span><strong>${analysis.returnExpressions.length}</strong></div>
          </div>
          <div class="muted">Helpers used: ${helperStats.length ? helperStats.map(([name, count]) => `${escapeHtml(name)}(${count})`).join(", ") : "none"}</div>
          ${renderIfRows(analysis.ifRows)}
        ` : `<div class="muted">Run <strong>Analyze PAC</strong> to see branch-level insights.</div>`}
      </div>

      <div class="card spaced">
        <h2>Execution Trace</h2>
        <div class="trace">${renderTrace(state.trace)}</div>
      </div>
    </div>

    <div class="card spaced" style="margin-top:16px;">
      <h2>Visualization</h2>
      <p class="muted">Control flow of <code>FindProxyForURL</code> including nested <code>if / else</code> branches.</p>
      <div id="graph">${analysis ? analysis.flowHtml : `<div class="muted">Run analysis to generate the control-flow graph.</div>`}</div>
    </div>
  `;

  document.getElementById("pacSource").addEventListener("input", (e) => {
    state.pacSource = e.target.value;
  });
  document.getElementById("pacUrl").addEventListener("input", (e) => {
    state.pacUrl = e.target.value;
  });
  document.getElementById("testUrl").addEventListener("input", (e) => {
    state.testUrl = e.target.value;
  });

  document.getElementById("reset").addEventListener("click", () => {
    state.pacSource = DEFAULT_PAC;
    state.error = "";
    state.result = "";
    state.pacUrl = "";
    state.analysis = null;
    state.trace = [];
    render();
  });

  document.getElementById("loadUrl").addEventListener("click", async () => {
    try {
      state.error = "";
      const response = await fetch(state.pacUrl);
      if (!response.ok) {
        throw new Error(`Failed to load PAC: ${response.status} ${response.statusText}`);
      }
      state.pacSource = await response.text();
      state.analysis = null;
      state.trace = [];
      render();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

  document.getElementById("analyze").addEventListener("click", async () => {
    try {
      state.error = "";
      state.analysis = analyzePac(state.pacSource);
      state.result = "PAC analyzed successfully.";
      state.trace = [];
      render();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

  document.getElementById("evaluate").addEventListener("click", () => {
    try {
      state.error = "";
      const analysisResult = analyzePac(state.pacSource);
      state.analysis = analysisResult;

      const runtime = createRuntime();
      const host = new URL(state.testUrl).hostname;
      const traceContext = { ...runtime, url: state.testUrl, host };
      const trace = [];
      const traced = traceExecution(analysisResult.statements, traceContext, trace);

      const evaluated = evaluatePac(state.pacSource, state.testUrl);
      state.result = String(evaluated);
      state.trace = trace;

      if (traced.returned && String(traced.value) !== String(evaluated)) {
        state.trace.push({
          type: "if-error",
          depth: 0,
          error: `Trace returned '${traced.value}' but runtime returned '${evaluated}'.`,
        });
      }

      render();
    } catch (error) {
      state.error = error.message;
      render();
    }
  });

}

render();
