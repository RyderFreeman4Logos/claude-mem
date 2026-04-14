#!/usr/bin/env bun
var __filename = require("node:url").fileURLToPath(import.meta.url);
var __dirname = require("node:path").dirname(__filename);
"use strict";var w=require("worker_threads");var Z=require("bun:sqlite");var g=require("path"),H=require("os"),O=require("fs");var Y=require("url");var I=require("fs"),L=require("path"),q=require("os"),x=(n=>(n[n.DEBUG=0]="DEBUG",n[n.INFO=1]="INFO",n[n.WARN=2]="WARN",n[n.ERROR=3]="ERROR",n[n.SILENT=4]="SILENT",n))(x||{}),j=process.env.CLAUDE_MEM_DATA_DIR||(0,L.join)((0,q.homedir)(),".claude-mem"),G=class{level=null;useColor;logFilePath=null;logFileInitialized=!1;constructor(){this.useColor=process.stdout.isTTY??!1}ensureLogFileInitialized(){if(!this.logFileInitialized){this.logFileInitialized=!0;try{let e=(0,L.join)(j,"logs");(0,I.existsSync)(e)||(0,I.mkdirSync)(e,{recursive:!0});let s=new Date().toISOString().split("T")[0];this.logFilePath=(0,L.join)(e,`claude-mem-${s}.log`)}catch(e){console.error("[LOGGER] Failed to initialize log file:",e),this.logFilePath=null}}}getLevel(){if(this.level===null)try{let e=(0,L.join)(j,"settings.json");if((0,I.existsSync)(e)){let s=(0,I.readFileSync)(e,"utf-8"),r=(JSON.parse(s).CLAUDE_MEM_LOG_LEVEL||"INFO").toUpperCase();this.level=x[r]??1}else this.level=1}catch{this.level=1}return this.level}correlationId(e,s){return`obs-${e}-${s}`}sessionId(e){return`session-${e}`}formatData(e){if(e==null)return"";if(typeof e=="string")return e;if(typeof e=="number"||typeof e=="boolean")return e.toString();if(typeof e=="object"){if(e instanceof Error)return this.getLevel()===0?`${e.message}
${e.stack}`:e.message;if(Array.isArray(e))return`[${e.length} items]`;let s=Object.keys(e);return s.length===0?"{}":s.length<=3?JSON.stringify(e):`{${s.length} keys: ${s.slice(0,3).join(", ")}...}`}return String(e)}formatTool(e,s){if(!s)return e;let t=s;if(typeof s=="string")try{t=JSON.parse(s)}catch{t=s}if(e==="Bash"&&t.command)return`${e}(${t.command})`;if(t.file_path)return`${e}(${t.file_path})`;if(t.notebook_path)return`${e}(${t.notebook_path})`;if(e==="Glob"&&t.pattern)return`${e}(${t.pattern})`;if(e==="Grep"&&t.pattern)return`${e}(${t.pattern})`;if(t.url)return`${e}(${t.url})`;if(t.query)return`${e}(${t.query})`;if(e==="Task"){if(t.subagent_type)return`${e}(${t.subagent_type})`;if(t.description)return`${e}(${t.description})`}return e==="Skill"&&t.skill?`${e}(${t.skill})`:e==="LSP"&&t.operation?`${e}(${t.operation})`:e}formatTimestamp(e){let s=e.getFullYear(),t=String(e.getMonth()+1).padStart(2,"0"),r=String(e.getDate()).padStart(2,"0"),n=String(e.getHours()).padStart(2,"0"),o=String(e.getMinutes()).padStart(2,"0"),i=String(e.getSeconds()).padStart(2,"0"),d=String(e.getMilliseconds()).padStart(3,"0");return`${s}-${t}-${r} ${n}:${o}:${i}.${d}`}log(e,s,t,r,n){if(e<this.getLevel())return;this.ensureLogFileInitialized();let o=this.formatTimestamp(new Date),i=x[e].padEnd(5),d=s.padEnd(6),u="";r?.correlationId?u=`[${r.correlationId}] `:r?.sessionId&&(u=`[session-${r.sessionId}] `);let p="";n!=null&&(n instanceof Error?p=this.getLevel()===0?`
${n.message}
${n.stack}`:` ${n.message}`:this.getLevel()===0&&typeof n=="object"?p=`
`+JSON.stringify(n,null,2):p=" "+this.formatData(n));let l="";if(r){let{sessionId:T,memorySessionId:N,correlationId:b,...c}=r;Object.keys(c).length>0&&(l=` {${Object.entries(c).map(([m,R])=>`${m}=${R}`).join(", ")}}`)}let E=`[${o}] [${i}] [${d}] ${u}${t}${l}${p}`;if(this.logFilePath)try{(0,I.appendFileSync)(this.logFilePath,E+`
`,"utf8")}catch(T){process.stderr.write(`[LOGGER] Failed to write to log file: ${T}
`)}else process.stderr.write(E+`
`)}debug(e,s,t,r){this.log(0,e,s,t,r)}info(e,s,t,r){this.log(1,e,s,t,r)}warn(e,s,t,r){this.log(2,e,s,t,r)}error(e,s,t,r){this.log(3,e,s,t,r)}dataIn(e,s,t,r){this.info(e,`\u2192 ${s}`,t,r)}dataOut(e,s,t,r){this.info(e,`\u2190 ${s}`,t,r)}success(e,s,t,r){this.info(e,`\u2713 ${s}`,t,r)}failure(e,s,t,r){this.error(e,`\u2717 ${s}`,t,r)}timing(e,s,t,r){this.info(e,`\u23F1 ${s}`,r,{duration:`${t}ms`})}happyPathError(e,s,t,r,n=""){let u=((new Error().stack||"").split(`
`)[2]||"").match(/at\s+(?:.*\s+)?\(?([^:]+):(\d+):(\d+)\)?/),p=u?`${u[1].split("/").pop()}:${u[2]}`:"unknown",l={...t,location:p};return this.warn(e,`[HAPPY-PATH] ${s}`,l,r),n}},a=new G;var oe={};function re(){return typeof __dirname<"u"?__dirname:(0,g.dirname)((0,Y.fileURLToPath)(oe.url))}var Re=re();function ne(){if(process.env.CLAUDE_MEM_DATA_DIR)return process.env.CLAUDE_MEM_DATA_DIR;let _=(0,g.join)((0,H.homedir)(),".claude-mem"),e=(0,g.join)(_,"settings.json");try{if((0,O.existsSync)(e)){let s=JSON.parse((0,O.readFileSync)(e,"utf-8")),t=s.env??s;if(t.CLAUDE_MEM_DATA_DIR)return t.CLAUDE_MEM_DATA_DIR}}catch{}return _}var f=ne(),D=process.env.CLAUDE_CONFIG_DIR||(0,g.join)((0,H.homedir)(),".claude"),Se=(0,g.join)(D,"plugins","marketplaces","thedotmack"),he=(0,g.join)(f,"archives"),Ne=(0,g.join)(f,"logs"),fe=(0,g.join)(f,"trash"),Ie=(0,g.join)(f,"backups"),Oe=(0,g.join)(f,"modes"),Ae=(0,g.join)(f,"settings.json"),V=(0,g.join)(f,"claude-mem.db"),Le=(0,g.join)(f,"vector-db"),De=(0,g.join)(f,"observer-sessions"),Ce=(0,g.join)(D,"settings.json"),ve=(0,g.join)(D,"commands"),ye=(0,g.join)(D,"CLAUDE.md");function K(_){(0,O.mkdirSync)(_,{recursive:!0})}var X="priority INTEGER NOT NULL DEFAULT 0",J=`ALTER TABLE pending_messages ADD COLUMN ${X}`;var Q=require("crypto");var ie=3e4;function C(_,e,s){return(0,Q.createHash)("sha256").update([_||"",e||"",s||""].join("\0")).digest("hex").slice(0,16)}function v(_,e,s){let t=s-ie;return _.prepare("SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?").get(e,t)}function B(_){if(!_)return[];try{let e=JSON.parse(_);return Array.isArray(e)?e:[String(e)]}catch{return[_]}}var S="claude";function ae(_){return _.trim().toLowerCase().replace(/\s+/g,"-")}function A(_){if(!_)return S;let e=ae(_);return e?e==="transcript"||e.includes("codex")?"codex":e.includes("cursor")?"cursor":e.includes("claude")?"claude":e:S}function z(_){let e=["claude","codex","cursor"];return[..._].sort((s,t)=>{let r=e.indexOf(s),n=e.indexOf(t);return r!==-1||n!==-1?r===-1?1:n===-1?-1:r-n:s.localeCompare(t)})}var de=5e3;function _e(_,e){return{customTitle:_,platformSource:e?A(e):void 0}}var y=class{db;constructor(e=V){e!==":memory:"&&K(f),this.db=new Z.Database(e),this.db.run("PRAGMA journal_mode = WAL"),this.db.run("PRAGMA synchronous = NORMAL"),this.db.run("PRAGMA foreign_keys = ON"),this.db.run(`PRAGMA busy_timeout = ${de}`),this.initializeSchema(),this.ensureWorkerPortColumn(),this.ensurePromptTrackingColumns(),this.removeSessionSummariesUniqueConstraint(),this.addObservationHierarchicalFields(),this.makeObservationsTextNullable(),this.createUserPromptsTable(),this.ensureDiscoveryTokensColumn(),this.createPendingMessagesTable(),this.addPendingMessagePriorityColumn(),this.renameSessionIdColumns(),this.repairSessionIdColumnRename(),this.addFailedAtEpochColumn(),this.ensurePendingMessagesLastAttemptedAtColumn(),this.addOnUpdateCascadeToForeignKeys(),this.addObservationContentHashColumn(),this.addSessionCustomTitleColumn(),this.addSessionPlatformSourceColumn(),this.addObservationModelColumns()}initializeSchema(){this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_versions (
        id INTEGER PRIMARY KEY,
        version INTEGER UNIQUE NOT NULL,
        applied_at TEXT NOT NULL
      )
    `),this.db.run(`
      CREATE TABLE IF NOT EXISTS sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT UNIQUE NOT NULL,
        memory_session_id TEXT UNIQUE,
        project TEXT NOT NULL,
        platform_source TEXT NOT NULL DEFAULT 'claude',
        user_prompt TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
      );

      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_claude_id ON sdk_sessions(content_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_sdk_id ON sdk_sessions(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_project ON sdk_sessions(project);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_status ON sdk_sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sdk_sessions_started ON sdk_sessions(started_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT NOT NULL,
        type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
      CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
      CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT UNIQUE NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(4,new Date().toISOString())}ensureWorkerPortColumn(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(t=>t.name==="worker_port")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN worker_port INTEGER"),a.debug("DB","Added worker_port column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(5,new Date().toISOString())}ensurePromptTrackingColumns(){this.db.query("PRAGMA table_info(sdk_sessions)").all().some(i=>i.name==="prompt_counter")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN prompt_counter INTEGER DEFAULT 0"),a.debug("DB","Added prompt_counter column to sdk_sessions table")),this.db.query("PRAGMA table_info(observations)").all().some(i=>i.name==="prompt_number")||(this.db.run("ALTER TABLE observations ADD COLUMN prompt_number INTEGER"),a.debug("DB","Added prompt_number column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(i=>i.name==="prompt_number")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN prompt_number INTEGER"),a.debug("DB","Added prompt_number column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(6,new Date().toISOString())}removeSessionSummariesUniqueConstraint(){if(!this.db.query("PRAGMA index_list(session_summaries)").all().some(t=>t.unique===1)){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString());return}a.debug("DB","Removing UNIQUE constraint from session_summaries.memory_session_id"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
      CREATE TABLE session_summaries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        request TEXT,
        investigated TEXT,
        learned TEXT,
        completed TEXT,
        next_steps TEXT,
        files_read TEXT,
        files_edited TEXT,
        notes TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO session_summaries_new
      SELECT id, memory_session_id, project, request, investigated, learned,
             completed, next_steps, files_read, files_edited, notes,
             prompt_number, created_at, created_at_epoch
      FROM session_summaries
    `),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
      CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
      CREATE INDEX idx_session_summaries_project ON session_summaries(project);
      CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(7,new Date().toISOString()),a.debug("DB","Successfully removed UNIQUE constraint from session_summaries.memory_session_id")}addObservationHierarchicalFields(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(8))return;if(this.db.query("PRAGMA table_info(observations)").all().some(r=>r.name==="title")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString());return}a.debug("DB","Adding hierarchical fields to observations table"),this.db.run(`
      ALTER TABLE observations ADD COLUMN title TEXT;
      ALTER TABLE observations ADD COLUMN subtitle TEXT;
      ALTER TABLE observations ADD COLUMN facts TEXT;
      ALTER TABLE observations ADD COLUMN narrative TEXT;
      ALTER TABLE observations ADD COLUMN concepts TEXT;
      ALTER TABLE observations ADD COLUMN files_read TEXT;
      ALTER TABLE observations ADD COLUMN files_modified TEXT;
    `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(8,new Date().toISOString()),a.debug("DB","Successfully added hierarchical fields to observations table")}makeObservationsTextNullable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(9))return;let t=this.db.query("PRAGMA table_info(observations)").all().find(r=>r.name==="text");if(!t||t.notnull===0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString());return}a.debug("DB","Making observations.text nullable"),this.db.run("BEGIN TRANSACTION"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
      CREATE TABLE observations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        text TEXT,
        type TEXT NOT NULL,
        title TEXT,
        subtitle TEXT,
        facts TEXT,
        narrative TEXT,
        concepts TEXT,
        files_read TEXT,
        files_modified TEXT,
        prompt_number INTEGER,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE
      )
    `),this.db.run(`
      INSERT INTO observations_new
      SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
             narrative, concepts, files_read, files_modified, prompt_number,
             created_at, created_at_epoch
      FROM observations
    `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
      CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
      CREATE INDEX idx_observations_project ON observations(project);
      CREATE INDEX idx_observations_type ON observations(type);
      CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
    `),this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(9,new Date().toISOString()),a.debug("DB","Successfully made observations.text nullable")}createUserPromptsTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(10))return;if(this.db.query("PRAGMA table_info(user_prompts)").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString());return}a.debug("DB","Creating user_prompts table with FTS5 support"),this.db.run("BEGIN TRANSACTION"),this.db.run(`
      CREATE TABLE user_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        prompt_number INTEGER NOT NULL,
        prompt_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        FOREIGN KEY(content_session_id) REFERENCES sdk_sessions(content_session_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_user_prompts_claude_session ON user_prompts(content_session_id);
      CREATE INDEX idx_user_prompts_created ON user_prompts(created_at_epoch DESC);
      CREATE INDEX idx_user_prompts_prompt_number ON user_prompts(prompt_number);
      CREATE INDEX idx_user_prompts_lookup ON user_prompts(content_session_id, prompt_number);
    `);try{this.db.run(`
        CREATE VIRTUAL TABLE user_prompts_fts USING fts5(
          prompt_text,
          content='user_prompts',
          content_rowid='id'
        );
      `),this.db.run(`
        CREATE TRIGGER user_prompts_ai AFTER INSERT ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;

        CREATE TRIGGER user_prompts_ad AFTER DELETE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
        END;

        CREATE TRIGGER user_prompts_au AFTER UPDATE ON user_prompts BEGIN
          INSERT INTO user_prompts_fts(user_prompts_fts, rowid, prompt_text)
          VALUES('delete', old.id, old.prompt_text);
          INSERT INTO user_prompts_fts(rowid, prompt_text)
          VALUES (new.id, new.prompt_text);
        END;
      `)}catch(t){a.warn("DB","FTS5 not available \u2014 user_prompts_fts skipped (search uses ChromaDB)",{},t)}this.db.run("COMMIT"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(10,new Date().toISOString()),a.debug("DB","Successfully created user_prompts table")}ensureDiscoveryTokensColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(11))return;this.db.query("PRAGMA table_info(observations)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE observations ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),a.debug("DB","Added discovery_tokens column to observations table")),this.db.query("PRAGMA table_info(session_summaries)").all().some(o=>o.name==="discovery_tokens")||(this.db.run("ALTER TABLE session_summaries ADD COLUMN discovery_tokens INTEGER DEFAULT 0"),a.debug("DB","Added discovery_tokens column to session_summaries table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(11,new Date().toISOString())}createPendingMessagesTable(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(16))return;if(this.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_messages'").all().length>0){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString());return}a.debug("DB","Creating pending_messages table"),this.db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL CHECK(message_type IN ('observation', 'summarize')),
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_user_message TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'processed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        ${X},
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        FOREIGN KEY (session_db_id) REFERENCES sdk_sessions(id) ON DELETE CASCADE
      )
    `),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_session ON pending_messages(session_db_id)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_status ON pending_messages(status)"),this.db.run("CREATE INDEX IF NOT EXISTS idx_pending_messages_claude_session ON pending_messages(content_session_id)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(16,new Date().toISOString()),a.debug("DB","pending_messages table created successfully")}addPendingMessagePriorityColumn(){let e=this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(28),t=this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="priority");e&&t||(t||(this.db.run(J),a.debug("DB","Added priority column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(28,new Date().toISOString()))}renameSessionIdColumns(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(17))return;a.debug("DB","Checking session ID columns for semantic clarity rename");let s=0,t=(r,n,o)=>{let i=this.db.query(`PRAGMA table_info(${r})`).all(),d=i.some(p=>p.name===n);return i.some(p=>p.name===o)?!1:d?(this.db.run(`ALTER TABLE ${r} RENAME COLUMN ${n} TO ${o}`),a.debug("DB",`Renamed ${r}.${n} to ${o}`),!0):(a.warn("DB",`Column ${n} not found in ${r}, skipping rename`),!1)};t("sdk_sessions","claude_session_id","content_session_id")&&s++,t("sdk_sessions","sdk_session_id","memory_session_id")&&s++,t("pending_messages","claude_session_id","content_session_id")&&s++,t("observations","sdk_session_id","memory_session_id")&&s++,t("session_summaries","sdk_session_id","memory_session_id")&&s++,t("user_prompts","claude_session_id","content_session_id")&&s++,this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(17,new Date().toISOString()),s>0?a.debug("DB",`Successfully renamed ${s} session ID columns`):a.debug("DB","No session ID column renames needed (already up to date)")}repairSessionIdColumnRename(){this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(19)||this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(19,new Date().toISOString())}addFailedAtEpochColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(20))return;this.db.query("PRAGMA table_info(pending_messages)").all().some(r=>r.name==="failed_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN failed_at_epoch INTEGER"),a.debug("DB","Added failed_at_epoch column to pending_messages table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(20,new Date().toISOString())}ensurePendingMessagesLastAttemptedAtColumn(){this.db.query("PRAGMA table_info(pending_messages)").all().some(t=>t.name==="last_attempted_at_epoch")||(this.db.run("ALTER TABLE pending_messages ADD COLUMN last_attempted_at_epoch INTEGER"),a.debug("DB","Added last_attempted_at_epoch column to pending_messages table"))}addOnUpdateCascadeToForeignKeys(){if(!this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(21)){a.debug("DB","Adding ON UPDATE CASCADE to FK constraints on observations and session_summaries"),this.db.run("PRAGMA foreign_keys = OFF"),this.db.run("BEGIN TRANSACTION");try{this.db.run("DROP TRIGGER IF EXISTS observations_ai"),this.db.run("DROP TRIGGER IF EXISTS observations_ad"),this.db.run("DROP TRIGGER IF EXISTS observations_au"),this.db.run("DROP TABLE IF EXISTS observations_new"),this.db.run(`
        CREATE TABLE observations_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          text TEXT,
          type TEXT NOT NULL,
          title TEXT,
          subtitle TEXT,
          facts TEXT,
          narrative TEXT,
          concepts TEXT,
          files_read TEXT,
          files_modified TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `),this.db.run(`
        INSERT INTO observations_new
        SELECT id, memory_session_id, project, text, type, title, subtitle, facts,
               narrative, concepts, files_read, files_modified, prompt_number,
               discovery_tokens, created_at, created_at_epoch
        FROM observations
      `),this.db.run("DROP TABLE observations"),this.db.run("ALTER TABLE observations_new RENAME TO observations"),this.db.run(`
        CREATE INDEX idx_observations_sdk_session ON observations(memory_session_id);
        CREATE INDEX idx_observations_project ON observations(project);
        CREATE INDEX idx_observations_type ON observations(type);
        CREATE INDEX idx_observations_created ON observations(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='observations_fts'").all().length>0&&this.db.run(`
          CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END;

          CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
          END;

          CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
            INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.text, old.facts, old.concepts);
            INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
            VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
          END;
        `),this.db.run("DROP TABLE IF EXISTS session_summaries_new"),this.db.run(`
        CREATE TABLE session_summaries_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_session_id TEXT NOT NULL,
          project TEXT NOT NULL,
          request TEXT,
          investigated TEXT,
          learned TEXT,
          completed TEXT,
          next_steps TEXT,
          files_read TEXT,
          files_edited TEXT,
          notes TEXT,
          prompt_number INTEGER,
          discovery_tokens INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          created_at_epoch INTEGER NOT NULL,
          FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
        )
      `),this.db.run(`
        INSERT INTO session_summaries_new
        SELECT id, memory_session_id, project, request, investigated, learned,
               completed, next_steps, files_read, files_edited, notes,
               prompt_number, discovery_tokens, created_at, created_at_epoch
        FROM session_summaries
      `),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ai"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_ad"),this.db.run("DROP TRIGGER IF EXISTS session_summaries_au"),this.db.run("DROP TABLE session_summaries"),this.db.run("ALTER TABLE session_summaries_new RENAME TO session_summaries"),this.db.run(`
        CREATE INDEX idx_session_summaries_sdk_session ON session_summaries(memory_session_id);
        CREATE INDEX idx_session_summaries_project ON session_summaries(project);
        CREATE INDEX idx_session_summaries_created ON session_summaries(created_at_epoch DESC);
      `),this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_summaries_fts'").all().length>0&&this.db.run(`
          CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END;

          CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
          END;

          CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
            INSERT INTO session_summaries_fts(session_summaries_fts, rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES('delete', old.id, old.request, old.investigated, old.learned, old.completed, old.next_steps, old.notes);
            INSERT INTO session_summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
            VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
          END;
        `),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(21,new Date().toISOString()),this.db.run("COMMIT"),this.db.run("PRAGMA foreign_keys = ON"),a.debug("DB","Successfully added ON UPDATE CASCADE to FK constraints")}catch(s){throw this.db.run("ROLLBACK"),this.db.run("PRAGMA foreign_keys = ON"),s}}}addObservationContentHashColumn(){if(this.db.query("PRAGMA table_info(observations)").all().some(t=>t.name==="content_hash")){this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString());return}this.db.run("ALTER TABLE observations ADD COLUMN content_hash TEXT"),this.db.run("UPDATE observations SET content_hash = substr(hex(randomblob(8)), 1, 16) WHERE content_hash IS NULL"),this.db.run("CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch)"),a.debug("DB","Added content_hash column to observations table with backfill and index"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(22,new Date().toISOString())}addSessionCustomTitleColumn(){if(this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(23))return;this.db.query("PRAGMA table_info(sdk_sessions)").all().some(r=>r.name==="custom_title")||(this.db.run("ALTER TABLE sdk_sessions ADD COLUMN custom_title TEXT"),a.debug("DB","Added custom_title column to sdk_sessions table")),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(23,new Date().toISOString())}addSessionPlatformSourceColumn(){let s=this.db.query("PRAGMA table_info(sdk_sessions)").all().some(o=>o.name==="platform_source"),r=this.db.query("PRAGMA index_list(sdk_sessions)").all().some(o=>o.name==="idx_sdk_sessions_platform_source");this.db.prepare("SELECT version FROM schema_versions WHERE version = ?").get(24)&&s&&r||(s||(this.db.run(`ALTER TABLE sdk_sessions ADD COLUMN platform_source TEXT NOT NULL DEFAULT '${S}'`),a.debug("DB","Added platform_source column to sdk_sessions table")),this.db.run(`
      UPDATE sdk_sessions
      SET platform_source = '${S}'
      WHERE platform_source IS NULL OR platform_source = ''
    `),r||this.db.run("CREATE INDEX IF NOT EXISTS idx_sdk_sessions_platform_source ON sdk_sessions(platform_source)"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(24,new Date().toISOString()))}addObservationModelColumns(){let e=this.db.query("PRAGMA table_info(observations)").all(),s=e.some(r=>r.name==="generated_by_model"),t=e.some(r=>r.name==="relevance_count");s&&t||(s||this.db.run("ALTER TABLE observations ADD COLUMN generated_by_model TEXT"),t||this.db.run("ALTER TABLE observations ADD COLUMN relevance_count INTEGER DEFAULT 0"),this.db.prepare("INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)").run(26,new Date().toISOString()))}updateMemorySessionId(e,s){this.db.prepare(`
      UPDATE sdk_sessions
      SET memory_session_id = ?
      WHERE id = ?
    `).run(s,e)}ensureMemorySessionIdRegistered(e,s){let t=this.db.prepare(`
      SELECT id, memory_session_id FROM sdk_sessions WHERE id = ?
    `).get(e);if(!t)throw new Error(`Session ${e} not found in sdk_sessions`);t.memory_session_id!==s&&(this.db.prepare(`
        UPDATE sdk_sessions SET memory_session_id = ? WHERE id = ?
      `).run(s,e),a.info("DB","Registered memory_session_id before storage (FK fix)",{sessionDbId:e,oldId:t.memory_session_id,newId:s}))}getRecentSummaries(e,s=10){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentSummariesWithSessionInfo(e,s=3){return this.db.prepare(`
      SELECT
        memory_session_id, request, learned, completed, next_steps,
        prompt_number, created_at
      FROM session_summaries
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getRecentObservations(e,s=20){return this.db.prepare(`
      SELECT type, text, prompt_number, created_at
      FROM observations
      WHERE project = ?
      ORDER BY created_at_epoch DESC
      LIMIT ?
    `).all(e,s)}getAllRecentObservations(e=100){return this.db.prepare(`
      SELECT
        o.id,
        o.type,
        o.title,
        o.subtitle,
        o.text,
        o.project,
        COALESCE(s.platform_source, '${S}') as platform_source,
        o.prompt_number,
        o.created_at,
        o.created_at_epoch
      FROM observations o
      LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentSummaries(e=50){return this.db.prepare(`
      SELECT
        ss.id,
        ss.request,
        ss.investigated,
        ss.learned,
        ss.completed,
        ss.next_steps,
        ss.files_read,
        ss.files_edited,
        ss.notes,
        ss.project,
        COALESCE(s.platform_source, '${S}') as platform_source,
        ss.prompt_number,
        ss.created_at,
        ss.created_at_epoch
      FROM session_summaries ss
      LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
      ORDER BY ss.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllRecentUserPrompts(e=100){return this.db.prepare(`
      SELECT
        up.id,
        up.content_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source,
        up.prompt_number,
        up.prompt_text,
        up.created_at,
        up.created_at_epoch
      FROM user_prompts up
      LEFT JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      ORDER BY up.created_at_epoch DESC
      LIMIT ?
    `).all(e)}getAllProjects(e){let s=e?A(e):void 0,t=`
      SELECT DISTINCT project
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
    `,r=[];return s&&(t+=" AND COALESCE(platform_source, ?) = ?",r.push(S,s)),t+=" ORDER BY project ASC",this.db.prepare(t).all(...r).map(o=>o.project)}getProjectCatalog(){let e=this.db.prepare(`
      SELECT
        COALESCE(platform_source, '${S}') as platform_source,
        project,
        MAX(started_at_epoch) as latest_epoch
      FROM sdk_sessions
      WHERE project IS NOT NULL AND project != ''
      GROUP BY COALESCE(platform_source, '${S}'), project
      ORDER BY latest_epoch DESC
    `).all(),s=[],t=new Set,r={};for(let o of e){let i=A(o.platform_source);r[i]||(r[i]=[]),r[i].includes(o.project)||r[i].push(o.project),t.has(o.project)||(t.add(o.project),s.push(o.project))}let n=z(Object.keys(r));return{projects:s,sources:n,projectsBySource:Object.fromEntries(n.map(o=>[o,r[o]||[]]))}}getLatestUserPrompt(e){return this.db.prepare(`
      SELECT
        up.*,
        s.memory_session_id,
        s.project,
        COALESCE(s.platform_source, '${S}') as platform_source
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.content_session_id = ?
      ORDER BY up.created_at_epoch DESC
      LIMIT 1
    `).get(e)}getRecentSessionsWithStatus(e,s=3){return this.db.prepare(`
      SELECT * FROM (
        SELECT
          s.memory_session_id,
          s.status,
          s.started_at,
          s.started_at_epoch,
          s.user_prompt,
          CASE WHEN sum.memory_session_id IS NOT NULL THEN 1 ELSE 0 END as has_summary
        FROM sdk_sessions s
        LEFT JOIN session_summaries sum ON s.memory_session_id = sum.memory_session_id
        WHERE s.project = ? AND s.memory_session_id IS NOT NULL
        GROUP BY s.memory_session_id
        ORDER BY s.started_at_epoch DESC
        LIMIT ?
      )
      ORDER BY started_at_epoch ASC
    `).all(e,s)}getObservationsForSession(e){return this.db.prepare(`
      SELECT title, subtitle, type, prompt_number
      FROM observations
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch ASC
    `).all(e)}getObservationById(e){return this.db.prepare(`
      SELECT *
      FROM observations
      WHERE id = ?
    `).get(e)||null}getObservationsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:n,type:o,concepts:i,files:d}=s,u=t==="date_asc"?"ASC":"DESC",p=r?`LIMIT ${r}`:"",l=e.map(()=>"?").join(","),E=[...e],T=[];if(n&&(T.push("project = ?"),E.push(n)),o)if(Array.isArray(o)){let c=o.map(()=>"?").join(",");T.push(`type IN (${c})`),E.push(...o)}else T.push("type = ?"),E.push(o);if(i){let c=Array.isArray(i)?i:[i],h=c.map(()=>"EXISTS (SELECT 1 FROM json_each(concepts) WHERE value = ?)");E.push(...c),T.push(`(${h.join(" OR ")})`)}if(d){let c=Array.isArray(d)?d:[d],h=c.map(()=>"(EXISTS (SELECT 1 FROM json_each(files_read) WHERE value LIKE ?) OR EXISTS (SELECT 1 FROM json_each(files_modified) WHERE value LIKE ?))");c.forEach(m=>{E.push(`%${m}%`,`%${m}%`)}),T.push(`(${h.join(" OR ")})`)}let N=T.length>0?`WHERE id IN (${l}) AND ${T.join(" AND ")}`:`WHERE id IN (${l})`;return this.db.prepare(`
      SELECT *
      FROM observations
      ${N}
      ORDER BY created_at_epoch ${u}
      ${p}
    `).all(...E)}getSummaryForSession(e){return this.db.prepare(`
      SELECT
        request, investigated, learned, completed, next_steps,
        files_read, files_edited, notes, prompt_number, created_at,
        created_at_epoch
      FROM session_summaries
      WHERE memory_session_id = ?
      ORDER BY created_at_epoch DESC
      LIMIT 1
    `).get(e)||null}getFilesForSession(e){let t=this.db.prepare(`
      SELECT files_read, files_modified
      FROM observations
      WHERE memory_session_id = ?
    `).all(e),r=new Set,n=new Set;for(let o of t)B(o.files_read).forEach(i=>r.add(i)),B(o.files_modified).forEach(i=>n.add(i));return{filesRead:Array.from(r),filesModified:Array.from(n)}}getSessionById(e){return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${S}') as platform_source,
             user_prompt, custom_title
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getSdkSessionsBySessionIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT id, content_session_id, memory_session_id, project,
             COALESCE(platform_source, '${S}') as platform_source,
             user_prompt, custom_title,
             started_at, started_at_epoch, completed_at, completed_at_epoch, status
      FROM sdk_sessions
      WHERE memory_session_id IN (${s})
      ORDER BY started_at_epoch DESC
    `).all(...e)}getPromptNumberFromUserPrompts(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM user_prompts WHERE content_session_id = ?
    `).get(e).count}createSDKSession(e,s,t,r,n){let o=new Date,i=o.getTime(),d=_e(r,n),u=d.platformSource??S,p=this.db.prepare(`
      SELECT id, platform_source FROM sdk_sessions WHERE content_session_id = ?
    `).get(e);if(p){if(s&&this.db.prepare(`
          UPDATE sdk_sessions SET project = ?
          WHERE content_session_id = ? AND (project IS NULL OR project = '')
        `).run(s,e),d.customTitle&&this.db.prepare(`
          UPDATE sdk_sessions SET custom_title = ?
          WHERE content_session_id = ? AND custom_title IS NULL
        `).run(d.customTitle,e),d.platformSource){let E=p.platform_source?.trim()?A(p.platform_source):void 0;if(!E)this.db.prepare(`
            UPDATE sdk_sessions SET platform_source = ?
            WHERE content_session_id = ?
              AND COALESCE(platform_source, '') = ''
          `).run(d.platformSource,e);else if(E!==d.platformSource)throw new Error(`Platform source conflict for session ${e}: existing=${E}, received=${d.platformSource}`)}return p.id}return this.db.prepare(`
      INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, user_prompt, custom_title, started_at, started_at_epoch, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'active')
    `).run(e,s,u,t,d.customTitle||null,o.toISOString(),i),this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e).id}markSessionCompleted(e){let s=new Date,t=s.getTime();return this.db.transaction(n=>{let o=this.db.prepare(`
        SELECT COUNT(*) as count FROM pending_messages
        WHERE session_db_id = ? AND status IN ('pending', 'processing')
      `).get(n);return o.count===0?(this.db.prepare(`
          UPDATE sdk_sessions
          SET status = 'completed',
              completed_at = ?,
              completed_at_epoch = ?
          WHERE id = ?
        `).run(s.toISOString(),t,n),a.debug("DB","Session marked as completed",{sessionDbId:n}),!0):(a.warn("DB","Attempted to mark session completed but queue not empty",{sessionDbId:n,pendingCount:o.count}),!1)})(e)}saveUserPrompt(e,s,t){let r=new Date,n=r.getTime();return this.db.prepare(`
      INSERT INTO user_prompts
      (content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)
    `).run(e,s,t,r.toISOString(),n).lastInsertRowid}getUserPrompt(e,s){return this.db.prepare(`
      SELECT prompt_text
      FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
      LIMIT 1
    `).get(e,s)?.prompt_text??null}checkObservationExists(e,s,t,r){return this.db.prepare(`
      SELECT id, created_at_epoch
      FROM observations
      WHERE memory_session_id = ?
        AND (title IS ? OR (title IS NULL AND ? IS NULL))
        AND (subtitle IS ? OR (subtitle IS NULL AND ? IS NULL))
        AND type = ?
    `).get(e,s,s,t,t,r)}storeObservation(e,s,t,r,n=0,o,i){let d=o??Date.now(),u=new Date(d).toISOString(),p=C(e,t.title,t.narrative),l=v(this.db,p,d);if(l)return{id:l.id,createdAtEpoch:l.created_at_epoch};let T=this.db.prepare(`
      INSERT INTO observations
      (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
       generated_by_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.type,t.title,t.subtitle,JSON.stringify(t.facts),t.narrative,JSON.stringify(t.concepts),JSON.stringify(t.files_read),JSON.stringify(t.files_modified),r||null,n,p,u,d,i||null);return{id:Number(T.lastInsertRowid),createdAtEpoch:d}}storeSummary(e,s,t,r,n=0,o){let i=o??Date.now(),d=new Date(i).toISOString(),p=this.db.prepare(`
      INSERT INTO session_summaries
      (memory_session_id, project, request, investigated, learned, completed,
       next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e,s,t.request,t.investigated,t.learned,t.completed,t.next_steps,t.notes,r||null,n,d,i);return{id:Number(p.lastInsertRowid),createdAtEpoch:i}}storeObservations(e,s,t,r,n,o=0,i,d){let u=i??Date.now(),p=new Date(u).toISOString();return this.db.transaction(()=>{let E=[],T=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let b of t){let c=C(e,b.title,b.narrative),h=v(this.db,c,u);if(h){E.push(h.id);continue}let m=T.run(e,s,b.type,b.title,b.subtitle,JSON.stringify(b.facts),b.narrative,JSON.stringify(b.concepts),JSON.stringify(b.files_read),JSON.stringify(b.files_modified),n||null,o,c,p,u,d||null);E.push(Number(m.lastInsertRowid))}let N=null;if(r){let c=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,n||null,o,p,u);N=Number(c.lastInsertRowid)}return{observationIds:E,summaryId:N,createdAtEpoch:u}})()}storeObservationsAndMarkComplete(e,s,t,r,n,o,i,d=0,u,p){let l=u??Date.now(),E=new Date(l).toISOString();return this.db.transaction(()=>{let N=[],b=this.db.prepare(`
        INSERT INTO observations
        (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
         files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch,
         generated_by_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);for(let m of t){let R=C(e,m.title,m.narrative),$=v(this.db,R,l);if($){N.push($.id);continue}let te=b.run(e,s,m.type,m.title,m.subtitle,JSON.stringify(m.facts),m.narrative,JSON.stringify(m.concepts),JSON.stringify(m.files_read),JSON.stringify(m.files_modified),i||null,d,R,E,l,p||null);N.push(Number(te.lastInsertRowid))}let c;if(r){let R=this.db.prepare(`
          INSERT INTO session_summaries
          (memory_session_id, project, request, investigated, learned, completed,
           next_steps, notes, prompt_number, discovery_tokens, created_at, created_at_epoch)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(e,s,r.request,r.investigated,r.learned,r.completed,r.next_steps,r.notes,i||null,d,E,l);c=Number(R.lastInsertRowid)}return this.db.prepare(`
        UPDATE pending_messages
        SET
          status = 'processed',
          completed_at_epoch = ?,
          tool_input = NULL,
          tool_response = NULL
        WHERE id = ? AND status = 'processing'
      `).run(l,n),{observationIds:N,summaryId:c,createdAtEpoch:l}})()}getSessionSummariesByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:n}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),u=[...e],p=n?`WHERE id IN (${d}) AND project = ?`:`WHERE id IN (${d})`;return n&&u.push(n),this.db.prepare(`
      SELECT * FROM session_summaries
      ${p}
      ORDER BY created_at_epoch ${o}
      ${i}
    `).all(...u)}getUserPromptsByIds(e,s={}){if(e.length===0)return[];let{orderBy:t="date_desc",limit:r,project:n}=s,o=t==="date_asc"?"ASC":"DESC",i=r?`LIMIT ${r}`:"",d=e.map(()=>"?").join(","),u=[...e],p=n?"AND s.project = ?":"";return n&&u.push(n),this.db.prepare(`
      SELECT
        up.*,
        s.project,
        s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.id IN (${d}) ${p}
      ORDER BY up.created_at_epoch ${o}
      ${i}
    `).all(...u)}getTimelineAroundTimestamp(e,s=10,t=10,r){return this.getTimelineAroundObservation(null,e,s,t,r)}getTimelineAroundObservation(e,s,t=10,r=10,n){let o=n?"AND project = ?":"",i=n?[n]:[],d,u;if(e!==null){let c=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id <= ? ${o}
        ORDER BY id DESC
        LIMIT ?
      `,h=`
        SELECT id, created_at_epoch
        FROM observations
        WHERE id >= ? ${o}
        ORDER BY id ASC
        LIMIT ?
      `;try{let m=this.db.prepare(c).all(e,...i,t+1),R=this.db.prepare(h).all(e,...i,r+1);if(m.length===0&&R.length===0)return{observations:[],sessions:[],prompts:[]};d=m.length>0?m[m.length-1].created_at_epoch:s,u=R.length>0?R[R.length-1].created_at_epoch:s}catch(m){return a.error("DB","Error getting boundary observations",void 0,{error:m,project:n}),{observations:[],sessions:[],prompts:[]}}}else{let c=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch <= ? ${o}
        ORDER BY created_at_epoch DESC
        LIMIT ?
      `,h=`
        SELECT created_at_epoch
        FROM observations
        WHERE created_at_epoch >= ? ${o}
        ORDER BY created_at_epoch ASC
        LIMIT ?
      `;try{let m=this.db.prepare(c).all(s,...i,t),R=this.db.prepare(h).all(s,...i,r+1);if(m.length===0&&R.length===0)return{observations:[],sessions:[],prompts:[]};d=m.length>0?m[m.length-1].created_at_epoch:s,u=R.length>0?R[R.length-1].created_at_epoch:s}catch(m){return a.error("DB","Error getting boundary timestamps",void 0,{error:m,project:n}),{observations:[],sessions:[],prompts:[]}}}let p=`
      SELECT *
      FROM observations
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${o}
      ORDER BY created_at_epoch ASC
    `,l=`
      SELECT *
      FROM session_summaries
      WHERE created_at_epoch >= ? AND created_at_epoch <= ? ${o}
      ORDER BY created_at_epoch ASC
    `,E=`
      SELECT up.*, s.project, s.memory_session_id
      FROM user_prompts up
      JOIN sdk_sessions s ON up.content_session_id = s.content_session_id
      WHERE up.created_at_epoch >= ? AND up.created_at_epoch <= ? ${o.replace("project","s.project")}
      ORDER BY up.created_at_epoch ASC
    `,T=this.db.prepare(p).all(d,u,...i),N=this.db.prepare(l).all(d,u,...i),b=this.db.prepare(E).all(d,u,...i);return{observations:T,sessions:N.map(c=>({id:c.id,memory_session_id:c.memory_session_id,project:c.project,request:c.request,completed:c.completed,next_steps:c.next_steps,created_at:c.created_at,created_at_epoch:c.created_at_epoch})),prompts:b.map(c=>({id:c.id,content_session_id:c.content_session_id,prompt_number:c.prompt_number,prompt_text:c.prompt_text,project:c.project,created_at:c.created_at,created_at_epoch:c.created_at_epoch}))}}getPromptById(e){return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id = ?
      LIMIT 1
    `).get(e)||null}getPromptsByIds(e){if(e.length===0)return[];let s=e.map(()=>"?").join(",");return this.db.prepare(`
      SELECT
        p.id,
        p.content_session_id,
        p.prompt_number,
        p.prompt_text,
        s.project,
        p.created_at,
        p.created_at_epoch
      FROM user_prompts p
      LEFT JOIN sdk_sessions s ON p.content_session_id = s.content_session_id
      WHERE p.id IN (${s})
      ORDER BY p.created_at_epoch DESC
    `).all(...e)}getSessionSummaryById(e){return this.db.prepare(`
      SELECT
        id,
        memory_session_id,
        content_session_id,
        project,
        user_prompt,
        request_summary,
        learned_summary,
        status,
        created_at,
        created_at_epoch
      FROM sdk_sessions
      WHERE id = ?
      LIMIT 1
    `).get(e)||null}getOrCreateManualSession(e){let s=`manual-${e}`,t=`manual-content-${e}`;if(this.db.prepare("SELECT memory_session_id FROM sdk_sessions WHERE memory_session_id = ?").get(s))return s;let n=new Date;return this.db.prepare(`
      INSERT INTO sdk_sessions (memory_session_id, content_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES (?, ?, ?, ?, ?, ?, 'active')
    `).run(s,t,e,S,n.toISOString(),n.getTime()),a.info("SESSION","Created manual session",{memorySessionId:s,project:e}),s}close(){this.db.close()}importSdkSession(e){let s=this.db.prepare("SELECT id FROM sdk_sessions WHERE content_session_id = ?").get(e.content_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source, user_prompt,
        started_at, started_at_epoch, completed_at, completed_at_epoch, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.memory_session_id,e.project,A(e.platform_source),e.user_prompt,e.started_at,e.started_at_epoch,e.completed_at,e.completed_at_epoch,e.status).lastInsertRowid}}importSessionSummary(e){let s=this.db.prepare("SELECT id FROM session_summaries WHERE memory_session_id = ?").get(e.memory_session_id);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO session_summaries (
        memory_session_id, project, request, investigated, learned,
        completed, next_steps, files_read, files_edited, notes,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.request,e.investigated,e.learned,e.completed,e.next_steps,e.files_read,e.files_edited,e.notes,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importObservation(e){let s=this.db.prepare(`
      SELECT id FROM observations
      WHERE memory_session_id = ? AND title = ? AND created_at_epoch = ?
    `).get(e.memory_session_id,e.title,e.created_at_epoch);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO observations (
        memory_session_id, project, text, type, title, subtitle,
        facts, narrative, concepts, files_read, files_modified,
        prompt_number, discovery_tokens, created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(e.memory_session_id,e.project,e.text,e.type,e.title,e.subtitle,e.facts,e.narrative,e.concepts,e.files_read,e.files_modified,e.prompt_number,e.discovery_tokens||0,e.created_at,e.created_at_epoch).lastInsertRowid}}importUserPrompt(e){let s=this.db.prepare(`
      SELECT id FROM user_prompts
      WHERE content_session_id = ? AND prompt_number = ?
    `).get(e.content_session_id,e.prompt_number);return s?{imported:!1,id:s.id}:{imported:!0,id:this.db.prepare(`
      INSERT INTO user_prompts (
        content_session_id, prompt_number, prompt_text,
        created_at, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?)
    `).run(e.content_session_id,e.prompt_number,e.prompt_text,e.created_at,e.created_at_epoch).lastInsertRowid}}};var pe=6e4,W=3e4,ee=120*1e3,M=10,ce=`
  UPDATE pending_messages
  SET
    retry_count = retry_count + 1,
    last_attempted_at_epoch = NULL,
    status = CASE
      WHEN retry_count + 1 >= ? THEN 'failed'
      ELSE 'pending'
    END,
    started_processing_at_epoch = NULL,
    failed_at_epoch = CASE
      WHEN retry_count + 1 >= ? THEN ?
      ELSE failed_at_epoch
    END
  WHERE session_db_id = ? AND status = 'processing'
    AND started_processing_at_epoch < ?
`,ue=`
  UPDATE pending_messages
  SET
    retry_count = retry_count + 1,
    last_attempted_at_epoch = NULL,
    status = CASE
      WHEN retry_count + 1 >= ? THEN 'failed'
      ELSE 'pending'
    END,
    started_processing_at_epoch = NULL,
    failed_at_epoch = CASE
      WHEN retry_count + 1 >= ? THEN ?
      ELSE failed_at_epoch
    END
  WHERE status = 'processing'
    AND started_processing_at_epoch < ?
`;function me(_){let e=W*Math.pow(2,Math.max(0,_-1));return Math.min(e,ee)}var U=class _{db;lastSelfHealLogAt=new Map;static SELF_HEAL_LOG_COALESCE_MS=6e4;constructor(e,s){this.db=e}resetStaleProcessing(e,s,t){return t!==void 0?{changes:this.db.prepare(ce).run(M,M,e,t,s).changes}:{changes:this.db.prepare(ue).run(M,M,e,s).changes}}enqueue(e,s,t,r=0){let n=Date.now();return this.db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type,
        tool_name, tool_input, tool_response, cwd,
        last_assistant_message,
        prompt_number, status, retry_count, priority, created_at_epoch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
    `).run(e,s,t.type,t.tool_name||null,t.tool_input?JSON.stringify(t.tool_input):null,t.tool_response?JSON.stringify(t.tool_response):null,t.cwd||null,t.last_assistant_message||null,t.prompt_number||null,r,n).lastInsertRowid}claimNextMessage(e){return this.db.transaction(t=>{let r=Date.now(),n=r-pe,o=this.resetStaleProcessing(r,n,t);if(o.changes>0){let l=t??-1,E=this.lastSelfHealLogAt.get(l)??0;r-E>=_.SELF_HEAL_LOG_COALESCE_MS&&(a.info("QUEUE",`SELF_HEAL | scope=${t??"global"} | recovered ${o.changes} stale processing message(s) (log coalesced to 1/60s)`),this.lastSelfHealLogAt.set(l,r))}let i=["status = 'pending'",`(
          last_attempted_at_epoch IS NULL
          OR last_attempted_at_epoch + (
            CASE
              WHEN retry_count <= 1 THEN ${W}
              WHEN retry_count <= 2 THEN ${W*2}
              ELSE ${ee}
            END
          ) <= ?
        )`,`(
          message_type != 'summarize'
          OR NOT EXISTS (
            SELECT 1
            FROM pending_messages blocker
            WHERE blocker.session_db_id = pending_messages.session_db_id
              AND blocker.id != pending_messages.id
              AND blocker.status IN ('pending', 'processing')
              AND blocker.message_type != 'summarize'
          )
        )`],d=[];t!==void 0&&(i.unshift("session_db_id = ?"),d.push(t)),d.push(r);let p=this.db.prepare(`
        SELECT * FROM pending_messages
        WHERE ${i.join(`
          AND `)}
        ORDER BY priority DESC, id ASC
        LIMIT 1
      `).get(...d);if(p){if(this.db.prepare(`
          UPDATE pending_messages
          SET status = 'processing', started_processing_at_epoch = ?
          WHERE id = ? AND status = 'pending'
        `).run(r,p.id).changes===0)return null;a.info("QUEUE",`CLAIMED | sessionDbId=${p.session_db_id} | messageId=${p.id} | type=${p.message_type}`,{sessionId:p.session_db_id})}return p})(e)}confirmProcessed(e){this.db.prepare("DELETE FROM pending_messages WHERE id = ?").run(e).changes>0&&a.debug("QUEUE",`CONFIRMED | messageId=${e} | deleted from queue`)}resetStaleProcessingMessages(e=300*1e3,s){let t=Date.now(),r=t-e,n=this.resetStaleProcessing(t,r,s);return n.changes>0&&a.info("QUEUE",`RESET_STALE | count=${n.changes} | thresholdMs=${e}${s!==void 0?` | sessionDbId=${s}`:""}`),n.changes}getAllPending(e){return this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE session_db_id = ? AND status = 'pending'
      ORDER BY id ASC
    `).all(e)}getQueueMessages(){return this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status IN ('pending', 'processing', 'failed')
      ORDER BY
        CASE pm.status
          WHEN 'failed' THEN 0
          WHEN 'processing' THEN 1
          WHEN 'pending' THEN 2
        END,
        pm.created_at_epoch ASC
    `).all()}getStuckCount(e){let s=Date.now()-e;return this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).get(s).count}retryMessage(e){return this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL, failed_at_epoch = NULL
      WHERE id = ? AND status IN ('pending', 'processing', 'failed')
    `).run(e).changes>0}resetProcessingToPending(e){return this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status = 'processing'
    `).run(e).changes}markSessionMessagesFailed(e){let s=Date.now(),r=this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending',
          retry_count = retry_count + 1,
          started_processing_at_epoch = NULL,
          last_attempted_at_epoch = ?
      WHERE session_db_id = ? AND status = 'processing'
    `).run(s,e);return r.changes>0&&a.info("QUEUE",`SESSION_AUTO_RETRY | sessionDbId=${e} | requeued=${r.changes} processing messages for retry`),r.changes}markAllSessionMessagesAbandoned(e){let t=this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending',
          failed_at_epoch = NULL,
          started_processing_at_epoch = NULL
      WHERE session_db_id = ? AND status IN ('processing', 'pending')
    `).run(e);return t.changes>0&&a.warn("QUEUE",`ABANDONED_REQUEUED | sessionDbId=${e} | requeued=${t.changes}`),t.changes}abortMessage(e){return this.db.prepare("DELETE FROM pending_messages WHERE id = ?").run(e).changes>0}retryAllStuck(e){let s=Date.now()-e;return this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(s).changes}getRecentlyProcessed(e=10,s=30){let t=Date.now()-s*60*1e3;return this.db.prepare(`
      SELECT pm.*, ss.project
      FROM pending_messages pm
      LEFT JOIN sdk_sessions ss ON pm.content_session_id = ss.content_session_id
      WHERE pm.status = 'processed' AND pm.completed_at_epoch > ?
      ORDER BY pm.completed_at_epoch DESC
      LIMIT ?
    `).all(t,e)}markFailed(e){let s=Date.now(),t=this.db.prepare("SELECT retry_count FROM pending_messages WHERE id = ?").get(e);if(!t)return;let r=t.retry_count+1,n=me(r);this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending',
          retry_count = ?,
          started_processing_at_epoch = NULL,
          failed_at_epoch = NULL,
          last_attempted_at_epoch = ?
      WHERE id = ?
    `).run(r,s,e),a.info("QUEUE",`AUTO_RETRY | messageId=${e} | retryCount=${r} | nextRetryIn=${Math.round(n/1e3)}s`)}resetStuckMessages(e){let s=e===0?Date.now():Date.now()-e;return this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(s).changes}getPendingCount(e){return this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
    `).get(e).count}getTotalPendingCount(){return this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `).get().count}getMessageStatus(e){return this.db.prepare(`
      SELECT status FROM pending_messages WHERE id = ?
    `).get(e)?.status??null}getFailedMessages(e,s){return this.db.prepare(`
      SELECT * FROM pending_messages
      WHERE status = 'failed'
      ORDER BY COALESCE(failed_at_epoch, created_at_epoch) DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(e,s)}getFailedMessageCount(){return this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status = 'failed'
    `).get().count}retryFailedMessage(e){return this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL, failed_at_epoch = NULL
      WHERE id = ? AND status = 'failed'
    `).run(e).changes===0?{success:!1,error:"Failed message not found"}:{success:!0,newMessageId:e}}deleteFailedMessage(e){return this.db.prepare(`
      DELETE FROM pending_messages
      WHERE id = ? AND status = 'failed'
    `).run(e).changes>0}clearFailedMessages(){return this.clearFailed()}peekPendingTypes(e){return this.db.prepare(`
      SELECT message_type, tool_name FROM pending_messages
      WHERE session_db_id = ? AND status IN ('pending', 'processing')
      ORDER BY id ASC
    `).all(e)}hasAnyPendingWork(){let e=Date.now()-3e5,t=this.db.prepare(`
      UPDATE pending_messages
      SET status = 'pending', started_processing_at_epoch = NULL
      WHERE status = 'processing' AND started_processing_at_epoch < ?
    `).run(e);return t.changes>0&&a.info("QUEUE",`STUCK_RESET | hasAnyPendingWork reset ${t.changes} stuck processing message(s) older than 5 minutes`),this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `).get().count>0}getSessionsWithPendingMessages(){return this.db.prepare(`
      SELECT DISTINCT session_db_id FROM pending_messages
      WHERE status IN ('pending', 'processing')
    `).all().map(t=>t.session_db_id)}getSessionInfoForMessage(e){let t=this.db.prepare(`
      SELECT session_db_id, content_session_id FROM pending_messages WHERE id = ?
    `).get(e);return t?{sessionDbId:t.session_db_id,contentSessionId:t.content_session_id}:null}clearFailed(){return this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status = 'failed'
    `).run().changes}clearAll(){return this.db.prepare(`
      DELETE FROM pending_messages
      WHERE status IN ('pending', 'processing', 'failed')
    `).run().changes}toPendingMessage(e){return{type:e.message_type,tool_name:e.tool_name||void 0,tool_input:e.tool_input?JSON.parse(e.tool_input):void 0,tool_response:e.tool_response?JSON.parse(e.tool_response):void 0,prompt_number:e.prompt_number||void 0,cwd:e.cwd||void 0,last_assistant_message:e.last_assistant_message||void 0}}toPendingMessageWithId(e){return{...this.toPendingMessage(e),_persistentId:e.id,_originalTimestamp:e.created_at_epoch}}};var se=w.workerData,F=w.parentPort;if(!F)throw new Error("Sqlite writer worker requires a parentPort");var P=new y(se.dbPath),k=new U(P.db,3);function le(_){if(!Number.isFinite(_)||_<=0)return;let e=new SharedArrayBuffer(4),s=new Int32Array(e);Atomics.wait(s,0,0,_)}function Ee(_){switch(_.type){case"claim":{let{sessionDbId:e}=_.payload;return k.claimNextMessage(e)}case"persist":{let{job:e}=_.payload;P.ensureMemorySessionIdRegistered(e.sessionDbId,e.memorySessionId),le(se.options?.commitDelayMs??0);let s=P.storeObservations(e.memorySessionId,e.project,e.observations,e.summary,e.lastPromptNumber,e.discoveryTokens,e.originalTimestamp??void 0,e.modelId);for(let t of e.processingMessageIds)k.confirmProcessed(t);return s}case"markFailed":{let{messageIds:e}=_.payload;for(let s of e)k.markFailed(s);return null}case"shutdown":return P.close(),null;default:{let e=_.type;throw new Error(`Unsupported sqlite writer request: ${String(e)}`)}}}F.on("message",_=>{try{let e=Ee(_),s={requestId:_.requestId,ok:!0,type:_.type,result:e};F.postMessage(s)}catch(e){if(_.type==="persist"){let{messageIds:r}={messageIds:_.payload.job.processingMessageIds};for(let n of r)k.markFailed(n)}let s=e instanceof Error?e:new Error(String(e)),t={requestId:_.requestId,ok:!1,type:_.type,error:{message:s.message,stack:s.stack}};F.postMessage(t)}});
