const express = require('express');
const { ApiError } = require('./lib/validation');
const app = express();
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With, X-HTTP-Method-Override, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
require('./routes')(app, express.Router());
app.use((req, res) => res.status(404).json({ message: 'Endpoint not found.', data: null }));
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = 500;
    let message = 'An unexpected server error occurred.';
    if (err instanceof ApiError) {
        status = err.status;
        message = err.message;
    } else if (err.code === 11000) {
        status = 400;
        message = 'This email is already in use.';
    } else if (['ValidationError', 'CastError'].includes(err.name) || err.type === 'entity.parse.failed') {
        status = 400;
        message = 'The request contains invalid fields or malformed JSON.';
    } else if (err.type === 'entity.too.large') {
        status = 400;
        message = 'The request body is too large.';
    }
    res.status(status).json({ message, data: null });
});
module.exports = app;
