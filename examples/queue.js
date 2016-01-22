/**
 * Created by root on 1/19/16.
 */
var bunyan = require('bunyan');
var path = require('path');
var fs = require('fs-extra');
var ALY = require('aliyun-sdk');
var async = require('async');
var later = require('later');
var sqlite3 = require('sqlite3').verbose();

var logFile = path.join(__dirname, '../queue.log');
var logger = bunyan.createLogger({
    name: 'queue',
    level: process.env.LOG_LEVEL || 'debug',
    src: true,
    streams: [{
        type: 'file',
        path: logFile
    }],
});

process.umask(0);
var dbFile = path.join(__dirname, '../nfs.db');
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, '', {mode: parseInt('0777', 8)});
}
var db = new sqlite3.Database(dbFile);

var libOSS = new ALY.OSS({
    "accessKeyId": 'ACSpY7WtwtOZJYFG',
    "secretAccessKey": 'CjQwnI6peo',
    "endpoint": 'http://oss-cn-hangzhou.aliyuncs.com',
    "apiVersion": "2013-10-15"
});
var ossStream = require('oss-upload-stream')(libOSS);
var bucket = 'gktest2';
var textSched = later.parse.text('every 1 min');
var timer = later.setInterval(upload, textSched);

function upload() {
    db.serialize(function () {
        db.all("SELECT * FROM OSS", function (err, rows) {
            if (!err && rows.length > 0) {
                async.eachLimit(rows, 1, function (row, callback) {
                    if (row.file && row.status != 'start') {
                        var upload = ossStream.upload({
                            "Bucket": bucket,
                            "Key": row.object
                        });
                        db.run("UPDATE File SET status = ? WHERE file = ?", 'start', row.file);
                        // Handle errors.
                        upload.on('error', function (error) {
                            logger.error('ossStream error', error);
                            //db.run("update FROM OSS WHERE file = ?", row.object);
                            row.count = row.count ? row.count + 1 : 1;
                            db.run("UPDATE OSS SET status = ?, count = ?, date = datetime('now', 'localtime') WHERE file = ?", error.message, row.count, row.file);
                            callback();
                        });
                        // Handle upload completion.
                        upload.on('uploaded', function (details) {
                            logger.info('ossStream uploaded', details);
                            db.run("DELETE FROM OSS WHERE file = ?", row.file);
                            callback();
                        });
                        // Pipe the incoming filestream through compression, and upload to Aliyun OSS.
                        fs.createReadStream(row.file).pipe(upload);
                    }
                });
            }
        });
    })
}
