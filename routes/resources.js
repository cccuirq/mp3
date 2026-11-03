const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/user');
const Task = require('../models/task');
const { fail, isId, userInput, taskInput, projection, listQuery } = require('../lib/validation');
const router = express.Router();

async function findResource(Model, id, session) {
    if (!isId(id)) fail(404, `${Model.modelName} not found.`);
    const doc = await Model.findById(id).session(session || null);
    if (!doc) fail(404, `${Model.modelName} not found.`);
    return doc;
}

// Every mutation and all of its reference updates commit or roll back together.
async function transaction(operation) {
    return mongoose.connection.transaction(operation);
}

async function saveUser(req, session) {
    const current = req.params.id ? await findResource(User, req.params.id, session) : null;
    const input = userInput(req.body);
    const duplicate = await User.findOne({ email: input.email }).session(session);
    if (duplicate && (!current || !duplicate._id.equals(current._id))) fail(400, 'This email is already in use.');
    const tasks = await Task.find({ _id: { $in: input.pendingTasks } }).session(session);
    if (tasks.some(task => task.completed)) fail(400, 'pendingTasks cannot contain completed tasks.');
    if (tasks.length !== input.pendingTasks.length) fail(404, 'A referenced task was not found.');
    const user = current || new User();
    const id = user._id.toString();
    const removed = (user.pendingTasks || []).filter(task => !input.pendingTasks.includes(task));
    user.set(input);
    await user.save({ session });
    await Task.updateMany({ _id: { $in: removed }, assignedUser: id }, {
        $set: { assignedUser: '', assignedUserName: 'unassigned' }
    }, { session });
    // Moving tasks also removes them from their previous owner's pending list.
    await User.updateMany({ _id: { $ne: user._id }, pendingTasks: { $in: input.pendingTasks } }, {
        $pull: { pendingTasks: { $in: input.pendingTasks } }
    }, { session });
    await Task.updateMany({ _id: { $in: input.pendingTasks } }, {
        $set: { assignedUser: id, assignedUserName: user.name }
    }, { session });
    // Completed tasks retain their owner and must follow a user's rename too.
    await Task.updateMany({ assignedUser: id }, { $set: { assignedUserName: user.name } }, { session });
    return user.toObject();
}

async function saveTask(req, session) {
    const current = req.params.id ? await findResource(Task, req.params.id, session) : null;
    const input = taskInput(req.body, Boolean(req.is('application/x-www-form-urlencoded')));
    if (input.assignedUser) {
        const user = await User.findById(input.assignedUser).session(session);
        if (!user) fail(404, 'The assigned user was not found.');
        if (input.assignedUserName !== undefined && input.assignedUserName !== user.name) {
            fail(400, 'assignedUserName does not match the assigned user.');
        }
        input.assignedUserName = user.name;
    } else {
        input.assignedUserName = 'unassigned';
    }
    const task = current || new Task();
    task.set(input);
    await task.save({ session });
    const id = task._id.toString();
    await User.updateMany({ pendingTasks: id }, { $pull: { pendingTasks: id } }, { session });
    if (task.assignedUser && !task.completed) {
        await User.updateOne({ _id: task.assignedUser }, { $addToSet: { pendingTasks: id } }, { session });
    }
    return task.toObject();
}

for (const [path, Model, save, defaultLimit] of [
    ['users', User, saveUser, 0], ['tasks', Task, saveTask, 100]
]) {
    router.get(`/${path}`, async (req, res) => {
        const { where, sort, select, skip, limit, count } = listQuery(req.query, defaultLimit);
        let data;
        try {
            data = count
                ? await Model.countDocuments(where)
                : await Model.find(where).sort(sort).select(select).skip(skip).limit(limit).lean();
        } catch (err) {
            if (err.name === 'CastError' || err.name === 'StrictModeError' ||
                (err.name === 'MongoServerError' && [2, 9, 14, 168, 31253, 31254].includes(err.code)) ||
                /^Can't use /.test(err.message)) fail(400, 'Invalid query parameters.');
            throw err;
        }
        res.json({ message: 'OK', data });
    });
    router.get(`/${path}/:id`, async (req, res) => {
        // Resolve the URL first; other list parameters are intentionally ignored.
        await findResource(Model, req.params.id);
        const data = await Model.findById(req.params.id).select(projection(req.query)).lean();
        if (!data) fail(404, `${Model.modelName} not found.`);
        res.json({ message: 'OK', data });
    });
    router.post(`/${path}`, async (req, res) => {
        const data = await transaction(session => save(req, session));
        res.status(201).json({ message: `${Model.modelName} created.`, data });
    });
    router.put(`/${path}/:id`, async (req, res) => {
        const data = await transaction(session => save(req, session));
        res.json({ message: `${Model.modelName} updated.`, data });
    });
    router.delete(`/${path}/:id`, async (req, res) => {
        await transaction(async session => {
            const doc = await findResource(Model, req.params.id, session);
            const id = doc._id.toString();
            if (Model === User) {
                await Task.updateMany({ assignedUser: id }, {
                    $set: { assignedUser: '', assignedUserName: 'unassigned' }
                }, { session });
            } else {
                await User.updateMany({ pendingTasks: id }, { $pull: { pendingTasks: id } }, { session });
            }
            await Model.deleteOne({ _id: doc._id }, { session });
        });
        // HTTP 204 has no response body.
        res.status(204).end();
    });
}
module.exports = router;
