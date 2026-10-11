/** Exercise production settings handlers and rendered controls without a browser dependency. */
import assert from 'node:assert/strict';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const nativeRequire = createRequire(import.meta.url);
let states = [], cursor = 0;
const hooks = { ...React,
    useState(initial) {
        const i = cursor++;
        if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial;
        return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }];
    },
    useEffect() {}, useMemo: fn => fn(), useCallback: fn => fn, useRef: value => ({ current: value }),
    useSyncExternalStore: (_subscribe, _client, server) => server(),
};
const bundled = await build({
    stdin: { contents: `export {FilterConfigPanel} from './src/components/FilterConfigPanel';
        export {OperatingEvidenceNotice} from './src/components/OperatingEvidenceNotice';
        export {DEFAULT_FILTER_CONFIG} from './src/lib/log-engine/filterDefaults';`, resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', write: false, packages: 'external',
    alias: { '@': path.join(root, 'src') },
});
const compiled = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(
    id => id === 'react' ? hooks : id === 'react-dom' ? { createPortal: node => node } : nativeRequire(id),
    compiled, compiled.exports,
);
const { FilterConfigPanel, OperatingEvidenceNotice, DEFAULT_FILTER_CONFIG } = compiled.exports;
function render(Component, props) { cursor = 0; return Component(props); }
function nodes(node) {
    if (Array.isArray(node)) return node.flatMap(nodes);
    if (!node || typeof node !== 'object') return [];
    return [node, ...nodes(node.props?.children)];
}
const find = (tree, predicate) => nodes(tree).find(predicate);
const testId = (tree, id) => find(tree, node => node.props?.['data-testid'] === id);
const html = tree => renderToStaticMarkup(tree);
const changes = [];
const diagnostics = React.createElement('button', { 'data-testid': 'diagnostic-fixture' }, 'RF応答の詳細');
const props = { config: { ...DEFAULT_FILTER_CONFIG, veCorrectionPolicy: 'moving-response' },
    onConfigChange: config => changes.push(config), diagnostics };

states = [];
let tree = render(FilterConfigPanel, props);
assert(!testId(tree, 've-replay-mode'));
find(tree, node => node.type === 'button').props.onClick();
tree = render(FilterConfigPanel, props);
const movingHtml = html(tree);
assert(movingHtml.includes('走行履歴Tune'));
assert(!movingHtml.includes('Max RPM Delta') && !movingHtml.includes('Max RO Delta'));
assert(!movingHtml.includes('data-filter-row="veGate"'));
assert(testId(tree, 'diagnostic-fixture'));
const replayDetails = find(tree, node => node.type === 'details');
assert(replayDetails && replayDetails.props.open !== true);
const selector = find(replayDetails, node => node.type === 'select');
assert(selector && selector.props.value === 'moving-response');
assert(!testId(tree, 've-moving-recalculate'));
selector.props.onChange({ target: { value: 'legacy-nominal' } });
assert.equal(changes.at(-1).veCorrectionPolicy, 'legacy-nominal');
console.log('PASS standard Tune exposes its current method; historical choices are collapsed and ignored VE knobs are absent');

for (const policy of [undefined, 'legacy-nominal', 'steady-retain', 'dme-response']) {
    states = [];
    const saved = { ...props, config: { ...props.config, veCorrectionPolicy: policy } };
    tree = render(FilterConfigPanel, saved);
    assert(testId(tree, 've-replay-mode'), 'closed settings must identify an old/comparison calculation');
    find(tree, node => node.type === 'button').props.onClick();
    tree = render(FilterConfigPanel, saved);
    testId(tree, 've-moving-recalculate').props.onClick();
    assert.equal(changes.at(-1).veCorrectionPolicy, 'moving-response');
}
console.log('PASS absent and explicit historical policies are visible while settings are closed and can switch explicitly to current Tune');

states = [];
const archived = { ...props, readOnly: true, config: { ...props.config, veCorrectionPolicy: undefined } };
tree = render(FilterConfigPanel, archived);
find(tree, node => node.type === 'button').props.onClick();
tree = render(FilterConfigPanel, archived);
const before = changes.length;
assert.equal(testId(tree, 've-moving-recalculate').props.disabled, true);
testId(tree, 've-moving-recalculate').props.onClick();
assert.equal(changes.length, before, 'archived settings cannot re-derive their saved result');
const disabledRegion = find(tree, node => node.props?.className?.includes('pointer-events-none'));
assert(!testId(disabledRegion, 'diagnostic-fixture'), 'read-only diagnostics must remain operable on archived records');
console.log('PASS archived settings preserve their calculation, while diagnostics remain outside the disabled controls');

states = [];
const evidenceProps = { raw: null, map: null, base: null, options: {}, logging: false };
tree = render(OperatingEvidenceNotice, evidenceProps);
assert(html(tree).includes('RF応答の詳細'));
assert(!html(tree).includes('従来Tune'));
assert(!testId(tree, 'rf-acquisition-open').props.className.includes('border-b'));
testId(tree, 'rf-acquisition-open').props.onClick();
globalThis.document = { body: {} };
tree = render(OperatingEvidenceNotice, evidenceProps);
assert(testId(tree, 'rf-acquisition-dialog'));
assert(!testId(tree, 'rf-acquisition-enable'));
delete globalThis.document;
console.log('PASS RF diagnostics has an inline trigger and read-only dialog with no second policy-changing action');
