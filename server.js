require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const app = require('./app');
const User = require('./models/user');
const Task = require('./models/task');

async function start() {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    // Build the unique email index before accepting requests.
    await Promise.all([User.init(), Task.init()]);
    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => console.log(`Server running on port ${port}; MongoDB connected.`));
    server.on('error', async () => {
        console.error('Unable to start the HTTP server. Check the port and permissions.');
        await mongoose.disconnect();
        process.exitCode = 1;
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => server.close(async () => {
            await mongoose.disconnect();
            process.exit(0);
        }));
    }
}
start().catch(async () => {
    console.error('Unable to initialize the database. Check the connection and Atlas access settings.');
    await mongoose.disconnect();
    process.exitCode = 1;
});
