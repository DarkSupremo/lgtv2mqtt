const _ = require('lodash');
const fs = require('fs');
const disableSyslog = process.env.DISABLE_SYSLOG;

let logName = process.env.name;

if (_.isNil(logName)) {
    logName = process.env.LOGGING_NAME;
}

if (_.isNil(logName)) {
    logName = 'logger';
}

const winston = require('winston');

const timezoned = () => {
    return new Date().toLocaleTimeString('en-US', {
        year: 'numeric',
        day: 'numeric',
        month: 'numeric',
        timeZoneName: 'short',
        timeZone: process.env.TZ
    });
};

const logFormat = function (shouldColor) {
    if (shouldColor) {
        return winston.format.combine(
            winston.format.label({label: '[' + logName + ']'}),
            winston.format.colorize(),
            winston.format.timestamp({
                format: timezoned
            }),
            winston.format.printf(info => `${info.timestamp} ${info.label} ${info.level}: ${info.message}`));
    }

    return winston.format.combine(
        winston.format.label({label: '[' + logName + ']'}),
        winston.format.timestamp({
            format: timezoned
        }),
        winston.format.printf(info => `${info.timestamp} ${info.label} ${info.level}: ${info.message}`));
};

const canWrite = function (directory) {
    const stat = fs.statSync(directory);

    // 2 is the octal value for chmod -w-
    return Boolean(2 & (stat.mode & 0o777).toString(8)[0]); // First char is the owner
};

let dailyFileLogger = null;
const loggingPath = process.env.LOG_PATH || '.';

if (!canWrite(loggingPath)) {
    dailyFileLogger = new (winston.transports.DailyRotateFile)({
        level: 'silly',
        filename: 'application-%DATE%.log',
        datePattern: 'YYYY-MM-DD-HH',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '7d',
        dirname: loggingPath,
        format: logFormat(false)
    });
}

const consoleLogger = new winston.transports.Console({
    level: 'info',
    format: logFormat(true)
});

const logger = winston.createLogger({
    levels: winston.config.cli.levels,
    transports: _.isNil(dailyFileLogger) ? [consoleLogger] : [consoleLogger, dailyFileLogger]
});

console.log('starting logging for: ' + logName);

if (disableSyslog !== false) {
    logger.info(' => console logging enabled');
}

module.exports = logger;
