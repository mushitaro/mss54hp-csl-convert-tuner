import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { build } from 'esbuild';
const root = path.resolve(import.meta.dirname, '..');
const bundle = await build({ entryPoints: [path.join(root, 'src/lib/ve-calculator/movingResponseFit.ts')],
    bundle: true, platform: 'node', format: 'esm', write: false });
const { fitMovingResponse } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
let checks = 0;
function test(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const rows = (bounds, shares = [{ cell: 0, weight: 1 }], visits = 3) =>
    Array.from({ length: visits }, (_, pass) => [1, 2].map(bank => ({ shares, ...bounds,
        time: pass * 20, bank, index: pass, model: 'm', pass: String(pass) }))).flat();
test('both banks and independent moving visits support a finite downward step', () => {
    const r = fitMovingResponse(rows({ upper: .8 }), 2);
    assert.equal(r.factors[0], .95); assert.equal(r.factors[1], 1);
    assert(r.afterLoss < r.beforeLoss); assert.equal(r.cells[1].reason, 'unsupported');
    assert.deepEqual(r.cells[0].improvedPasses, [3, 3]);
});
test('dense records and transport variants cannot turn one physical pass into two', () => {
    const one = rows({ upper: .8 }, undefined, 1);
    const repeated = Array.from({ length: 100 }, (_, i) => one.map(r => ({ ...r, model: 'm' + i }))).flat();
    assert.equal(fitMovingResponse(repeated, 1).factors[0], 1);
    const noIds = Array.from({ length: 1000 }, (_, i) => [1, 2].map(bank => ({ shares: [{ cell: 0, weight: 1 }],
        upper: .8, time: i / 10, bank, index: i, model: 'm' }))).flat();
    assert.equal(fitMovingResponse(noIds, 1).factors[0], 1);
});
test('one opposing bank or validation passage prevents an unsupported change', () => {
    const conflicting = rows({ upper: .8 });
    conflicting.push({ ...conflicting[0], upper: undefined, lower: 1.01, pass: 'opposes', time: 70 });
    assert.equal(fitMovingResponse(conflicting, 1).factors[0], 1);
    const banks = rows({ upper: .8 }).map(r => r.bank === 1 ? r : { ...r, upper: undefined, lower: 1.1 });
    assert.equal(fitMovingResponse(banks, 1).factors[0], 1);
});
test('combined coordinates are checked after each accepted step', () => {
    const both = rows({ lower: .97, upper: .99 }, [{ cell: 0, weight: .5 }, { cell: 1, weight: .5 }]);
    const r = fitMovingResponse(both, 2);
    assert(r.accepted.length >= 1); assert.equal(r.afterLoss, 0);
    assert(r.groups.every(g => g.afterLoss <= g.beforeLoss));
    assert.equal(r.factors[0], .975);
});
test('small physical errors converge with a 5% maximum instead of stalling', () => {
    let table = 1;
    for (let iteration = 0; iteration < 10; iteration++) {
        const r = fitMovingResponse(rows({ lower: .979 / table, upper: .981 / table }), 1);
        table *= r.factors[0];
    }
    assert(table >= .979 && table <= .981, `did not converge: ${table}`);
});
test('duplicating rows leaves factors, independent support and total loss unchanged', () => {
    const a = rows({ upper: .8 }); const r = fitMovingResponse(a, 1), duplicate = fitMovingResponse([...a, ...a], 1);
    assert.deepEqual(r.factors, duplicate.factors); assert.deepEqual(r.cells[0].passes, duplicate.cells[0].passes);
    assert(Math.abs(r.beforeLoss - duplicate.beforeLoss) < 1e-12);
});
test('duplicate cell shares are merged without renormalizing envelope coefficients', () => {
    const a = rows({ upper: .3 }, [{ cell: 0, weight: .2 }, { cell: 0, weight: .3 }]);
    const b = rows({ upper: .3 }, [{ cell: 0, weight: .5 }]);
    assert.deepEqual(fitMovingResponse(a, 1).factors, fitMovingResponse(b, 1).factors);
    assert.equal(fitMovingResponse(rows({ upper: .6 }, [{ cell: 0, weight: .5 }]), 1).factors[0], 1);
});
test('unsupported and invalid constraints never silently manufacture an estimate', () => {
    assert.equal(fitMovingResponse([], 1).cells[0].reason, 'unsupported');
    assert.throws(() => fitMovingResponse(rows({ upper: NaN }), 1));
    assert.throws(() => fitMovingResponse(rows({ lower: 2, upper: 1 }), 1));
});
test('five-fold predictions learn direction without seeing held-out observations', () => {
    const repeated = rows({ upper: .8 }, undefined, 20).map(r => ({ ...r, time: r.time * 3 }));
    const result = fitMovingResponse(repeated, 1, { validationFolds: 5, crossValidate: true });
    assert.equal(result.factors[0], .95);
    assert.deepEqual(result.validation.cells[0].trainingFactors, Array(5).fill(.95));
    assert.deepEqual(result.validation.cells[0].improvedTestFolds, [5, 5]);
    assert(result.validation.afterLoss < result.validation.beforeLoss);
});
test('information confined to one time fold cannot pass cross-validation', () => {
    const repeated = rows({ upper: 1.1 }, undefined, 20).map(r => ({ ...r, time: r.time * 3,
        upper: r.index >= 16 ? .8 : 1.1 }));
    const result = fitMovingResponse(repeated, 1, { validationFolds: 5, crossValidate: true });
    assert.equal(result.factors[0], 1); assert.equal(result.cells[0].reason, 'cross-validation');
});
test('two held-out visits in one fifth validate the joint moving prediction', () => {
    // A bilinear neighbour is learned on other visits. Holding out the two
    // mixed visits moves the correction into that neighbour; the two unseen
    // predictions still improve, even though the isolated target coefficient
    // is one in that training fit. Never mistake basis allocation for no data.
    const spec = [[0,.96],[0,.96],[.9,.98],[.9,.98],[.9,1.02],[.9,1.02],
        [0,.96],[0,.96],[.9,1.02],[.9,1.02]];
    const mixed = spec.flatMap(([a, upper], index) => [1,2].map(bank => ({
        shares: [{cell:0,weight:a},{cell:1,weight:1-a}],upper,index,bank,
        time:index*60,model:'m',pass:String(index) })));
    const result = fitMovingResponse(mixed,2,{validationFolds:5,crossValidate:true});
    assert(result.factors[0] < 1);
    const target=result.validation.cells[0];
    assert.deepEqual(target.improvedTestFolds,[0,0]);
    assert.deepEqual(target.regionalImprovedTestPasses,[2,2]);
    assert(target.regionalGroupChanges.every(g => g.change <= 1e-12));
    const oneVisit=mixed.map(r => r.index===3 ? {...r,upper:1.02} : r);
    assert.equal(fitMovingResponse(oneVisit,2,{validationFolds:5,crossValidate:true}).factors[0],1);
});
if (process.argv[2]) {
    const file = path.resolve(process.argv[2]); const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    const crossValidate = process.argv.includes('--cross-validate');
    const result = fitMovingResponse(fixture.rows, fixture.cellCount, crossValidate ? { validationFolds: 5, crossValidate: true } : {});
    fs.writeFileSync(file.replace(/\.json$/, crossValidate ? '-crossfit.json' : '-fit.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ fixture: file, rows: fixture.rows.length, accepted: result.accepted.length,
        target: result.factors[289], beforeLoss: result.beforeLoss, afterLoss: result.afterLoss,
        maxGroupIncrease: Math.max(0, ...result.groups.map(g => g.afterLoss - g.beforeLoss)),
        crossValidation: result.validation ? { before: result.validation.beforeLoss, after: result.validation.afterLoss,
            rejectedCells: result.validation.rejectedCells, target: result.validation.cells[289] } : undefined }));
}
console.log(`PASS ${checks} moving-response finite-update checks`);
