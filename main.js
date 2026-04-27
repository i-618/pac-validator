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

const CORS_PROXY_ENDPOINTS = [
  {
    name: "allorigins",
    buildUrl: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  },
  {
    name: "isomorphic-git",
    buildUrl: (url) => `https://cors.isomorphic-git.org/${url}`,
  },
];

const state = {
  pacSource: DEFAULT_PAC,
  pacUrl: "",
  testUrl: "https://www.example.com",
  result: "",
  loadInfo: "",
  isLoadingPac: false,
  error: "",
  analysis: null,
  trace: [],
};

async function loadPacSourceFromUrl(rawUrl) {
  const pacUrl = String(rawUrl || "").trim();
  if (!pacUrl) {
    throw new Error("Enter a PAC URL first.");
  }

  let normalizedUrl;
  try {
    normalizedUrl = new URL(pacUrl).toString();
  } catch {
    throw new Error("PAC URL is not valid.");
  }

  let directError;
  try {
    const response = await fetch(normalizedUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return {
      source: await response.text(),
      loadedVia: "direct",
    };
  } catch (error) {
    directError = error;
  }

  for (const endpoint of CORS_PROXY_ENDPOINTS) {
    try {
      const response = await fetch(endpoint.buildUrl(normalizedUrl));
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return {
        source: await response.text(),
        loadedVia: `proxy (${endpoint.name})`,
      };
    } catch {
      // Keep trying next proxy endpoint.
    }
  }

  const reason = directError && directError.message ? directError.message : "Request blocked";
  throw new Error(`Unable to load PAC URL. Direct request failed (${reason}) and proxy retries also failed.`);
}

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

function parseStatements(source, start = 0, stop = source.length, ctx = { ifCount: 0, forCount: 0 }) {
  const statements = [];
  let i = start;

  while (i < stop) {
    i = skipWhitespaceAndComments(source, i);
    if (i >= stop) break;

    if (source.startsWith("for", i) && !/[A-Za-z0-9_$]/.test(source[i + 3] || "")) {
      const parsedFor = parseForStatement(source, i, ctx);
      statements.push(parsedFor.node);
      i = parsedFor.end;
      continue;
    }

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
      } else if (/^var\b/.test(raw)) {
        const declaration = raw.replace(/^var\s+/, "").replace(/;\s*$/, "").trim();
        statements.push({
          type: "var",
          declaration,
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

function parseForStatement(source, start, ctx) {
  let i = start + 3;
  i = skipWhitespaceAndComments(source, i);
  if (source[i] !== "(") {
    throw new Error("Malformed for statement: missing loop header.");
  }

  const header = readBalanced(source, i, "(", ")");
  i = skipWhitespaceAndComments(source, header.end);
  if (source[i] !== "{") {
    throw new Error("Malformed for statement: expected block body.");
  }

  const bodyBlock = readBalanced(source, i, "{", "}");
  const bodyStatements = parseStatements(bodyBlock.content, 0, bodyBlock.content.length, ctx);
  i = bodyBlock.end;

  const node = {
    type: "for",
    id: `for_${++ctx.forCount}`,
    header: header.content.trim(),
    body: bodyStatements,
  };

  return { node, end: i };
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
  function ipToInt(ip) {
    const parts = String(ip).trim().split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      throw new Error(`Invalid IPv4 address: ${ip}`);
    }
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
  }

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
    isInNet(host, pattern, mask) {
      try {
        const hostIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : this.dnsResolve(host);
        const hostInt = ipToInt(hostIp);
        const patternInt = ipToInt(pattern);
        const maskInt = ipToInt(mask);
        return (hostInt & maskInt) === (patternInt & maskInt);
      } catch {
        return false;
      }
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

const MAX_TRACE_LOOP_ITERATIONS = 2000;

function splitTopLevel(source, delimiter) {
  const parts = [];
  let quote = "";
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let last = 0;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth -= 1;
    else if (ch === "[") bracketDepth += 1;
    else if (ch === "]") bracketDepth -= 1;
    else if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;

    if (ch === delimiter && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parts.push(source.slice(last, i).trim());
      last = i + 1;
    }
  }

  parts.push(source.slice(last).trim());
  return parts;
}

function applyVarDeclaration(declaration, context) {
  const entries = splitTopLevel(declaration, ",");
  for (const entry of entries) {
    if (!entry) continue;
    const eqIndex = entry.indexOf("=");
    if (eqIndex < 0) {
      const varName = entry.trim();
      if (varName) context[varName] = undefined;
      continue;
    }
    const varName = entry.slice(0, eqIndex).trim();
    const rhs = entry.slice(eqIndex + 1).trim();
    if (!varName) continue;
    context[varName] = rhs ? evaluateExpression(rhs, context) : undefined;
  }
}

function executeStatement(raw, context) {
  const fn = new Function("ctx", `with (ctx) { ${raw} }`);
  fn(context);
}

function parseForHeader(header) {
  const parts = splitTopLevel(header, ";");
  if (parts.length !== 3) {
    throw new Error(`Unsupported for-loop header: ${header}`);
  }
  return {
    init: parts[0],
    condition: parts[1],
    update: parts[2],
  };
}

function executeForSegment(segment, context) {
  const text = String(segment || "").trim();
  if (!text) return;
  if (/^var\b/.test(text)) {
    applyVarDeclaration(text.replace(/^var\s+/, "").trim(), context);
    return;
  }
  executeStatement(text, context);
}

function traceExecution(statements, context, trace, depth = 0) {
  for (const node of statements) {
    if (node.type === "var") {
      applyVarDeclaration(node.declaration, context);
      continue;
    }

    if (node.type === "statement") {
      try {
        executeStatement(node.raw, context);
      } catch {
        // Best-effort trace execution for non-control statements.
      }
      continue;
    }

    if (node.type === "for") {
      let header;
      try {
        header = parseForHeader(node.header);
      } catch (error) {
        trace.push({
          type: "if-error",
          id: node.id,
          depth,
          condition: `for (${node.header})`,
          error: error.message,
        });
        throw error;
      }

      trace.push({
        type: "for",
        id: node.id,
        depth,
        header: node.header,
      });

      try {
        executeForSegment(header.init, context);
      } catch (error) {
        trace.push({
          type: "if-error",
          id: node.id,
          depth,
          condition: `for-init (${header.init})`,
          error: error.message,
        });
        throw error;
      }

      let iteration = 0;
      while (true) {
        let decision = true;
        try {
          decision = header.condition ? Boolean(evaluateExpression(header.condition, context)) : true;
        } catch (error) {
          trace.push({
            type: "if-error",
            id: node.id,
            depth,
            condition: `for-cond (${header.condition})`,
            error: error.message,
          });
          throw error;
        }

        trace.push({
          type: "for-check",
          id: node.id,
          depth,
          condition: header.condition || "(true)",
          decision,
          iteration,
        });

        if (!decision) break;
        if (iteration >= MAX_TRACE_LOOP_ITERATIONS) {
          trace.push({
            type: "trace-note",
            id: node.id,
            depth,
            message: `Trace truncated at ${MAX_TRACE_LOOP_ITERATIONS} iterations for ${node.id}.`,
          });
          break;
        }

        const nested = traceExecution(node.body, context, trace, depth + 1);
        if (nested.returned) return nested;

        try {
          executeForSegment(header.update, context);
        } catch (error) {
          trace.push({
            type: "if-error",
            id: node.id,
            depth,
            condition: `for-update (${header.update})`,
            error: error.message,
          });
          throw error;
        }
        iteration += 1;
      }
      continue;
    }

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
      } else if (node.type === "for") {
        collectReturns(node.body, out);
      } else if (node.type === "if") {
        collectReturns(node.then, out);
        collectReturns(node.else, out);
      }
    }
  }

  function walk(nodes, depth) {
    for (const node of nodes) {
      if (node.type === "for") {
        walk(node.body, depth + 1);
        continue;
      }
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
    if (node.type === "for") {
      collectReturnExpressions(node.body, out);
    }
    if (node.type === "if") {
      collectReturnExpressions(node.then, out);
      collectReturnExpressions(node.else, out);
    }
  }
  return out;
}

function countNodeType(statements, targetType) {
  let count = 0;
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === targetType) count += 1;
      if (node.type === "if") {
        walk(node.then);
        walk(node.else);
      } else if (node.type === "for") {
        walk(node.body);
      }
    }
  }
  walk(statements);
  return count;
}

function renderFlowNodes(nodes, depth = 0) {
  if (!nodes.length) {
    return `<div class="flow-empty" style="margin-left:${depth * 16}px;">(no statements)</div>`;
  }
  return nodes.map((node) => {
    if (node.type === "var") {
      return `
        <div class="flow-node" style="margin-left:${depth * 16}px;">
          <div class="flow-kind">var</div>
          <div class="flow-text">${escapeHtml(compactText(node.declaration, 120))}</div>
        </div>
      `;
    }
    if (node.type === "for") {
      return `
        <div class="flow-node" style="margin-left:${depth * 16}px;">
          <div class="flow-kind">for</div>
          <div class="flow-text"><code>${escapeHtml(compactText(node.header, 120))}</code></div>
          <div class="flow-branch">
            <div class="flow-branch-label ok">loop body</div>
            ${renderFlowNodes(node.body, depth + 1)}
          </div>
          <div class="flow-branch">
            <div class="flow-branch-label muted">after loop</div>
          </div>
        </div>
      `;
    }
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
  const loopCount = countNodeType(statements, "for");
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
    loopCount,
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
    if (step.type === "for") {
      return `<div class="trace-line">${indent}<strong>${escapeHtml(step.id)}</strong> for (<code>${escapeHtml(step.header)}</code>)</div>`;
    }
    if (step.type === "for-check") {
      return `<div class="trace-line">${indent}<strong>${escapeHtml(step.id)}</strong> condition [iter ${step.iteration}] ${escapeHtml(step.condition)} => <span class="${step.decision ? "ok" : "muted"}">${step.decision}</span></div>`;
    }
    if (step.type === "if") {
      return `<div class="trace-line">${indent}<strong>${escapeHtml(step.id)}</strong> ${escapeHtml(step.condition)} => <span class="${step.decision ? "ok" : "muted"}">${step.decision}</span></div>`;
    }
    if (step.type === "return") {
      return `<div class="trace-line">${indent}<strong>return</strong> ${escapeHtml(step.expression)} => <span class="ok">${escapeHtml(step.value)}</span></div>`;
    }
    if (step.type === "trace-note") {
      return `<div class="trace-line muted">${indent}${escapeHtml(step.message || "Trace note")}</div>`;
    }
    return `<div class="trace-line error">${indent}${escapeHtml(step.error || "Trace error")}</div>`;
  }).join("\n");
}

function render() {
  const analysis = state.analysis;
  const helperStats = analysis ? Object.entries(analysis.helperUsage).sort((a, b) => b[1] - a[1]) : [];

  app.innerHTML = `
    <h1>PAC Validator</h1>
    <p class="muted">Analyze control flow in <code>FindProxyForURL</code>, inspect branch outcomes, and see a visual decision graph plus runtime trace.</p>

    <div class="grid">
      <div class="card spaced">
        <h2>PAC Source</h2>
        <label for="pacUrl">PAC URL</label>
        <div class="actions">
          <input id="pacUrl" placeholder="https://example.com/proxy.pac" value="${escapeHtml(state.pacUrl)}" />
          <button id="loadUrl" ${state.isLoadingPac ? "disabled" : ""}>${state.isLoadingPac ? "Loading..." : "Load URL"}</button>
        </div>
        ${state.isLoadingPac ? `<div class="muted loading-inline"><span class="spinner" aria-hidden="true"></span>Fetching PAC from URL...</div>` : ""}

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
        ${state.loadInfo ? `<div class="muted">${escapeHtml(state.loadInfo)}</div>` : ""}
        ${state.error ? `<div class="error"><strong>Error:</strong> ${escapeHtml(state.error)}</div>` : ""}
      </div>
    </div>

    <div class="grid" style="margin-top:16px;">
      <div class="card spaced">
        <h2>Insights</h2>
        ${analysis ? `
            <div class="insight-cards">
              <div><span class="muted">If blocks</span><strong>${analysis.ifRows.length}</strong></div>
              <div><span class="muted">For loops</span><strong>${analysis.loopCount}</strong></div>
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
      <p class="muted">Control flow of <code>FindProxyForURL</code> including nested <code>if / else</code> and <code>for</code> blocks.</p>
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
    state.loadInfo = "";
    state.isLoadingPac = false;
    state.pacUrl = "";
    state.analysis = null;
    state.trace = [];
    render();
  });

  document.getElementById("loadUrl").addEventListener("click", async () => {
    if (state.isLoadingPac) return;
    try {
      state.error = "";
      state.isLoadingPac = true;
      render();
      const loaded = await loadPacSourceFromUrl(state.pacUrl);
      state.pacSource = loaded.source;
      state.loadInfo = `Loaded PAC from URL via ${loaded.loadedVia}.`;
      state.analysis = null;
      state.trace = [];
    } catch (error) {
      state.loadInfo = "";
      state.error = error.message;
    } finally {
      state.isLoadingPac = false;
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
