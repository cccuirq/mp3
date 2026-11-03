const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const app = require('../app');
const User = require('../models/user');
const Task = require('../models/task');
const database = `mp3_test_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
let server, base;
const deadline = '2026-12-01T12:00:00.000Z';
const missing = '000000000000000000000001';
const query = params => '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, JSON.stringify(v)]));

before(async () => {
    assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI in .env before running integration tests.');
    await mongoose.connect(process.env.MONGODB_URI, { dbName: database, serverSelectionTimeoutMS: 15000 });
    await Promise.all([User.init(), Task.init()]);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    try {
        // Only this run's random, isolated database may be removed.
        if (mongoose.connection.readyState === 1 && mongoose.connection.name === database) {
            await mongoose.connection.dropDatabase();
        }
    } finally { await mongoose.disconnect(); }
});
async function request(method, path, body, status = 200, headers = {}) {
    const response = await fetch(base + path, {
        method, headers: { 'Content-Type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
    if (status === 204) { assert.equal(raw, ''); return; }
    const json = JSON.parse(raw);
    assert.equal(typeof json.message, 'string');
    assert.ok(Object.hasOwn(json, 'data'));
    return json.data;
}
const createUser = (name, extra = {}) => request('POST', '/users', { name, email: `${randomUUID()}@example.com`, ...extra }, 201);
const createTask = (name, extra = {}) => request('POST', '/tasks', { name, deadline, ...extra }, 201);
const getUser = id => request('GET', `/users/${id}`);
const getTask = id => request('GET', `/tasks/${id}`);
const snapshot = async () => JSON.stringify({
    users: await User.find().sort({ _id: 1 }).lean(), tasks: await Task.find().sort({ _id: 1 }).lean()
});

// One ordered scenario keeps related assertions readable without parallel state changes.
test('MP3 API integration', async t => {
    let alice, bob, task;
    await t.test('create defaults, server timestamps, required fields and strict types', async () => {
        alice = await createUser('Alice', { dateCreated: '2000-01-01' });
        bob = await createUser('Bob');
        assert.deepEqual(alice.pendingTasks, []);
        assert.ok(new Date(alice.dateCreated).getFullYear() > 2000);
        task = await createTask('First', { dateCreated: '2000-01-01' });
        assert.equal(task.completed, false);
        assert.equal(task.description, '');
        assert.equal(task.assignedUser, '');
        assert.equal(task.assignedUserName, 'unassigned');
        assert.ok(new Date(task.dateCreated).getFullYear() > 2000);
        for (const body of [{}, { name: 'A' }, { name: 12, email: 'a' }, { name: ' ', email: 'b' }, { name: 'A', email: [] }]) {
            await request('POST', '/users', body, 400);
        }
        for (const body of [{}, { name: 'A' }, { name: 'A', deadline: 'bad' }, { name: 'A', deadline: null },
            { name: 'A', deadline, completed: 'false' }, { name: 'A', deadline, description: 5 }]) {
            await request('POST', '/tasks', body, 400);
        }
        await request('POST', '/users', { name: 'Copy', email: alice.email }, 400);
        await request('POST', '/tasks', '{broken', 400);
    });
    await t.test('assignment, completion, reopening, transfer and timestamps', async () => {
        let updated = await request('PUT', `/tasks/${task._id}`, { name: 'First', deadline, assignedUser: alice._id });
        assert.equal(updated.assignedUserName, 'Alice');
        assert.equal(updated.dateCreated, task.dateCreated);
        assert.deepEqual((await getUser(alice._id)).pendingTasks, [task._id]);
        await request('PUT', `/tasks/${task._id}`, { name: 'First', deadline, completed: true, assignedUser: alice._id });
        assert.deepEqual((await getUser(alice._id)).pendingTasks, []);
        assert.equal((await getTask(task._id)).assignedUser, alice._id);
        await request('PUT', `/tasks/${task._id}`, { name: 'First', deadline, completed: true, assignedUser: bob._id });
        assert.deepEqual((await getUser(bob._id)).pendingTasks, []);
        await request('PUT', `/tasks/${task._id}`, { name: 'First', deadline, assignedUser: bob._id });
        assert.deepEqual((await getUser(bob._id)).pendingTasks, [task._id]);
        updated = await request('PUT', `/users/${alice._id}`, { name: 'Alice renamed', email: alice.email, pendingTasks: [task._id] });
        assert.equal(updated.dateCreated, alice.dateCreated);
        assert.deepEqual((await getUser(bob._id)).pendingTasks, []);
        assert.equal((await getTask(task._id)).assignedUserName, 'Alice renamed');
        assert.equal((await getTask(task._id)).assignedUser, alice._id);
        await request('PUT', `/users/${alice._id}`, { name: 'Alice', email: alice.email });
        assert.equal((await getTask(task._id)).assignedUser, '');
        assert.deepEqual((await getUser(alice._id)).pendingTasks, []);
        updated = await request('PUT', `/tasks/${task._id}`, { name: 'Reset', deadline });
        assert.equal(updated.completed, false);
        assert.equal(updated.assignedUserName, 'unassigned');
    });
    await t.test('failed mutations preserve every document; URL and body ID errors', async () => {
        const done = await createTask('Done', { completed: true });
        const original = await snapshot();
        for (const path of ['/users/not-an-id', `/users/${missing}`, '/tasks/no', `/tasks/${missing}`]) {
            await request('GET', path, undefined, 404);
            await request('PUT', path, {}, 404);
            await request('DELETE', path, undefined, 404);
        }
        for (const [pendingTasks, status] of [[['bad'], 400], [[missing], 404], [[done._id], 400], ['bad', 400]]) {
            await request('PUT', `/users/${alice._id}`, { name: 'Changed', email: alice.email, pendingTasks }, status);
        }
        await request('PUT', `/users/${alice._id}`, { name: 'Changed', email: bob.email }, 400);
        for (const [extra, status] of [
            [{ assignedUser: 'bad' }, 400], [{ assignedUser: missing }, 404],
            [{ assignedUser: bob._id, assignedUserName: 'Wrong' }, 400], [{ completed: 1 }, 400]
        ]) await request('PUT', `/tasks/${task._id}`, { name: 'Changed', deadline, ...extra }, status);
        assert.equal(await snapshot(), original);
    });
    await t.test('POST references, deduplication, renaming completed tasks, deletion cleanup', async () => {
        const first = await createTask('Transferred', { assignedUser: bob._id });
        const owner = await createUser('Owner', { pendingTasks: [first._id, first._id] });
        assert.deepEqual(owner.pendingTasks, [first._id]);
        assert.equal((await getTask(first._id)).assignedUser, owner._id);
        assert.ok(!(await getUser(bob._id)).pendingTasks.includes(first._id));
        const completed = await createTask('Completed', { completed: true, assignedUser: owner._id });
        await request('PUT', `/users/${owner._id}`, { name: 'Renamed', email: owner.email, pendingTasks: [first._id] });
        assert.equal((await getTask(completed._id)).assignedUserName, 'Renamed');
        await request('DELETE', `/tasks/${first._id}`, undefined, 204);
        assert.deepEqual((await getUser(owner._id)).pendingTasks, []);
        await request('GET', `/tasks/${first._id}`, undefined, 404);
        const pending = await createTask('Pending', { assignedUser: owner._id });
        await request('DELETE', `/users/${owner._id}`, undefined, 204);
        for (const id of [completed._id, pending._id]) {
            const unassigned = await getTask(id);
            assert.equal(unassigned.assignedUser, '');
            assert.equal(unassigned.assignedUserName, 'unassigned');
        }
        await request('GET', `/users/${owner._id}`, undefined, 404);
    });
    await t.test('combined Mongoose filters, sort, projection, pagination and counts', async () => {
        const ids = [];
        for (const name of ['Query C', 'Query A', 'Query B']) ids.push((await createTask(name))._id);
        const where = { _id: { $in: ids } };
        const selected = await request('GET', '/tasks' + query({ where, sort: { name: 1 }, select: { name: 1, _id: 0 }, skip: 1, limit: 1 }));
        assert.deepEqual(selected, [{ name: 'Query B' }]);
        assert.equal(await request('GET', '/tasks' + query({ where, count: true, skip: 1, limit: 1 })), 3);
        assert.deepEqual(await request('GET', '/tasks' + query({ where: { _id: missing } })), []);
        assert.equal(await request('GET', '/users' + query({ where: { _id: missing }, count: true })), 0);
        assert.deepEqual(await request('GET', `/users/${alice._id}` + query({ select: { name: 1, _id: 0 } })), { name: 'Alice' });
        assert.deepEqual(await request('GET', `/tasks/${ids[0]}` + query({ select: { name: 1, _id: 0 } })), { name: 'Query C' });
        assert.equal((await request('GET', `/users/${alice._id}?where=invalid&count=invalid`))._id, alice._id);
        for (const suffix of ['?where={', '?sort=[]', '?skip=-1', '?limit="2"', '?count=1', '?select={"name":2}',
            '?select={"name":1,"email":0}', '?where={"_id":"bad"}', '?sort={"name":0}']) {
            await request('GET', '/users' + suffix, undefined, 400);
        }
        await request('GET', `/tasks/${task._id}?select={`, undefined, 400);
        const users = await request('GET', '/users' + query({ where: { _id: { $in: [alice._id, bob._id] } }, sort: { name: -1 }, skip: 1, limit: 1 }));
        assert.equal(users[0]._id, alice._id);
    });
    await t.test('default task limit and unlimited users', async () => {
        await Task.insertMany(Array.from({ length: 105 }, (_, i) => ({ name: `Bulk ${i}`, deadline })));
        await User.insertMany(Array.from({ length: 105 }, (_, i) => ({ name: `Bulk ${i}`, email: `bulk${i}@example.com` })));
        assert.equal((await request('GET', '/tasks')).length, 100);
        assert.ok((await request('GET', '/tasks?limit=0')).length > 100);
        assert.ok((await request('GET', '/users')).length > 100);
    });
    await t.test('URL-encoded requests, OPTIONS and generic 404', async () => {
        const result = await request('POST', '/tasks', new URLSearchParams({ name: 'Form', deadline, completed: 'false' }).toString(), 201,
            { 'Content-Type': 'application/x-www-form-urlencoded' });
        assert.equal(result.completed, false);
        await request('OPTIONS', '/tasks', undefined, 204);
        await request('GET', '/not-found', undefined, 404);
        const root = await request('GET', '');
        assert.equal(root.users, '/api/users');
    });
    await t.test('concurrent duplicate emails and transfers preserve consistency', async () => {
        const email = `${randomUUID()}@example.com`;
        const responses = await Promise.all([1, 2].map(() => fetch(base + '/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Concurrent', email })
        })));
        assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]);
        await Promise.all(responses.map(r => r.text()));
        await Promise.all([alice, bob].map(user => request('PUT', `/tasks/${task._id}`, {
            name: 'Concurrent task', deadline, assignedUser: user._id
        })));
        const final = await getTask(task._id);
        for (const user of [alice, bob]) {
            assert.equal((await getUser(user._id)).pendingTasks.includes(task._id), final.assignedUser === user._id);
        }
    });
    await t.test('database failure returns a sanitized 500 and transaction rolls back', async () => {
        const before = await snapshot();
        const original = Task.updateMany;
        Task.updateMany = async () => { throw new Error('private database details'); };
        try {
            const response = await fetch(base + `/users/${alice._id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Must roll back', email: alice.email })
            });
            assert.equal(response.status, 500);
            const body = await response.json();
            assert.equal(body.data, null);
            assert.ok(!body.message.includes('private'));
        } finally { Task.updateMany = original; }
        assert.equal(await snapshot(), before);
    });
});
