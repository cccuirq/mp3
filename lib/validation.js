class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
const fail = (status, message) => { throw new ApiError(status, message); };
const isId = value => typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function bodyObject(body) {
    if (!isObject(body)) fail(400, 'A request body containing fields is required.');
    return body;
}
function requiredString(value, field) {
    if (typeof value !== 'string' || !value.trim()) fail(400, `${field} is required and must be a nonempty string.`);
    return value;
}
function optionalString(body, field, fallback) {
    if (body[field] === undefined) return fallback;
    if (typeof body[field] !== 'string') fail(400, `${field} must be a string.`);
    return body[field];
}
function userInput(input) {
    const body = bodyObject(input);
    const name = requiredString(body.name, 'name');
    const email = requiredString(body.email, 'email');
    const tasks = body.pendingTasks === undefined ? [] : body.pendingTasks;
    if (!Array.isArray(tasks) || !tasks.every(isId)) fail(400, 'pendingTasks must be a list of valid task IDs.');
    return { name, email, pendingTasks: [...new Set(tasks.map(id => id.toLowerCase()))] };
}
function taskInput(input, formEncoded = false) {
    const body = bodyObject(input);
    const name = requiredString(body.name, 'name');
    if (!['string', 'number'].includes(typeof body.deadline) || body.deadline === '') {
        fail(400, 'deadline is required and must be a valid date.');
    }
    const deadline = new Date(body.deadline);
    if (Number.isNaN(deadline.getTime())) fail(400, 'deadline must be a valid date.');
    let completed = body.completed === undefined ? false : body.completed;
    if (formEncoded && ['true', 'false'].includes(completed)) completed = completed === 'true';
    if (typeof completed !== 'boolean') fail(400, 'completed must be a boolean.');
    const assignedUser = optionalString(body, 'assignedUser', '');
    if (assignedUser && !isId(assignedUser)) fail(400, 'assignedUser must be a valid user ID or an empty string.');
    return {
        name, deadline, completed,
        description: optionalString(body, 'description', ''),
        assignedUser: assignedUser.toLowerCase(),
        assignedUserName: optionalString(body, 'assignedUserName', undefined)
    };
}

function jsonParameter(query, key, fallback) {
    if (query[key] === undefined) return fallback;
    try {
        if (typeof query[key] !== 'string') throw new Error();
        return JSON.parse(query[key]);
    } catch { fail(400, `${key} must contain valid JSON.`); }
}
function objectParameter(query, key) {
    const value = jsonParameter(query, key, {});
    if (!isObject(value)) fail(400, `${key} must be a JSON object.`);
    return value;
}
function projection(query) {
    const select = objectParameter(query, 'select');
    if (Object.values(select).some(value => value !== 0 && value !== 1)) fail(400, 'select values must be 0 or 1.');
    const modes = new Set(Object.entries(select).filter(([key]) => key !== '_id').map(([, value]) => value));
    if (modes.size > 1) fail(400, 'select cannot mix included and excluded fields except for _id.');
    return select;
}
function listQuery(query, defaultLimit) {
    const where = objectParameter(query, 'where');
    const sort = objectParameter(query, 'sort');
    if (Object.values(sort).some(value => value !== 1 && value !== -1)) fail(400, 'sort values must be 1 or -1.');
    const select = projection(query);
    const skip = jsonParameter(query, 'skip', 0);
    const limit = jsonParameter(query, 'limit', defaultLimit);
    for (const [key, value] of Object.entries({ skip, limit })) {
        if (!Number.isSafeInteger(value) || value < 0) fail(400, `${key} must be a nonnegative integer.`);
    }
    const count = jsonParameter(query, 'count', false);
    if (typeof count !== 'boolean') fail(400, 'count must be a boolean.');
    return { where, sort, select, skip, limit, count };
}
module.exports = { ApiError, fail, isId, userInput, taskInput, projection, listQuery };
