var ReplayParser;

ReplayParser = (function() {
    function ReplayParser() {}

    /**
     * Parses a replay for a match
     * @param {object} payload
     * @param {boolean} overrideDelete true prevents deletion of replay file after parsing
     * @param {function} cb
     */
    ReplayParser.parseReplay = function(payload, overrideDelete, cb) {
        if(!Settings.get('replay-folder') || !Settings.get('steam-folder')) {
            alertify.error("Please check your folder settings.");
            return cb("Error");
        }
        if(!Settings.get('steam-user') || !Settings.get('steam-password')) {
            alertify.error("Please provide a steam username and password.");
            return cb("Error");
        }
        if(!fs.existsSync(Settings.get('replay-folder'))) fs.mkdir(Settings.get('replay-folder'));
        var match_id = payload.data.match_id;
        logger.info("[PARSER] match %s", match_id);
        ReplayParser.download(payload, function(err, fileName) {
            if(err) {
                if(err === "MATCH IS TOO OLD") {
                    logger.error("[PARSER] Match %s is too old", match_id);
                    //mark unavailable if unable to find in s3
                    db.matches.update({
                        match_id: match_id
                    }, {
                        $set: {
                            parse_status: 1
                        }
                    });
                    return cb(null); //Mark as done
                }
                logger.error("[PARSER] Error for match %s: %s", match_id, err);
                return cb(err);
            }
            logger.info("[PARSER] running parse on %s", fileName);
            var execPath = path.dirname( process.execPath );
            var parserPath = path.join(execPath, '/parser/dist');
            var parser_file;
            if(getOperatingSystem() == "windows") parser_file = 'parser.exe';
            else if(getOperatingSystem() == "linux") parser_file = 'java -jar parser/stats-0.1.0.jar';
            exec(parser_file + ' "' + fileName + '"', {cwd: parserPath}, function (err, stdout) {
                logger.info('[PARSER] Finished parsing %s', match_id);
                if(!err) {
                    //process parser output
                    db.matches.update({
                        match_id: match_id
                    }, {
                        $set: {
                            parsed_data: JSON.parse(stdout),
                            parse_status: 2
                        }
                    });
                    if(Settings.get('delete-replays') == 'true' && !overrideDelete) {
                        fs.unlink(fileName);
                    }
                }
                return cb(err);
            });
        });
    };

    /**
     * Downloads a match replay
     * @param {object} payload
     * @param {function} cb
     */
    ReplayParser.download = function(payload, cb) {
        var match_id = payload.data.match_id;
        var fileName = Settings.get('replay-folder') + path.sep + match_id + ".dem";
        if(fs.existsSync(fileName)) {
            logger.info("[PARSER] found local replay for match %s", match_id);
            cb(null, fileName);
        } else {
            ReplayParser.getReplayUrl(payload, function(err, url) {
                if(err) return cb(err);
                logger.info("[PARSER] downloading from %s", url);
                request({
                    url: url,
                    encoding: null
                }, function(err, response, body) {
                    if(err || response.statusCode !== 200) {
                        logger.error("[PARSER] failed to download from %s", url);
                        return cb("DOWNLOAD TIMEOUT");
                    } else {
                        try {
                            var decomp = Bunzip.decode(body);
                            fs.writeFile(fileName, decomp, function(err) {
                                if(err) {
                                    return cb(err);
                                }
                                logger.info("[PARSER] downloaded/decompressed replay for match %s", match_id);
                                var archiveName = match_id + ".dem.bz2";
                                fs.unlink(archiveName);
                                return cb(null, fileName);
                            });
                        } catch(e) {
                            return cb(e);
                        }
                    }
                });
            });
        }
    };

    ReplayParser.getReplayUrl = function(payload, cb) {
        if(payload.url) return cb(null, payload.url);
        var match = payload.data;
        if(match.replay_salt) 
            return cb(null, "http://replay" + match.cluster + ".valve.net/570/" + match.match_id + "_" + match.replay_salt + ".dem.bz2");
        else if(match.start_time > moment().subtract(7, 'days').format('X')) {
            DotaUtils.assureSteamConnection(function() {
                logger.info("[DOTA] requesting replay %s", match.match_id);
                // Try to get replay for 15 sec, else give up and try again later.
                dotaUtils.setTimeout();
                Dota2.matchDetailsRequest(match.match_id, function(err, data) {
                    var url = "http://replay" + data.match.cluster + ".valve.net/570/" + match.match_id + "_" + data.match.replaySalt + ".dem.bz2";
                    dotaUtils.removeTimeout();
                    //Add url to job so we don't need to check again.
                    payload.url = url;
                    return cb(null, url);
                });
            });
        } else {
            cb("MATCH IS TOO OLD");
        }
    };

    return ReplayParser;
})();