import express from 'express';
import fs from 'fs';
import chalk from 'chalk';
import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

/* ================================
   SECURITY / AUTHENTICATION
================================ */

const SERVER_PASSWORD = process.env.SERVER_PASSWORD || 'AFFANMARK376';
const authTokens = new Set();

app.use(cors());
app.use(express.json({ limit: '2mb' }));


/* ================================
   LOGIN PAGE & AUTH ENDPOINTS
================================ */

app.post('/api/verify-password', (req, res) => {
  const { password } = req.body;

  if (password === SERVER_PASSWORD) {
    const token = `token_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    authTokens.add(token);

    return res.json({
      success: true,
      token,
      message: 'Access granted'
    });
  }

  return res.json({
    success: false,
    message: 'Incorrect Password!'
  });
});

app.use((req, res, next) => {
  if (req.path === '/login' || req.path === '/api/verify-password') {
    return next();
  }

  const token = req.headers['authorization'] || req.query.token;

  if (authTokens.has(token)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Password required'
    });
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>AFFAN AUTOMATION - RED EDITION</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
        body { background: #080000; color: #ff3355; display: flex; align-items: center; justify-content: center; height: 100vh; overflow: hidden; }
        .login-card { background: #140204; border: 2px solid #ff0033; border-radius: 12px; padding: 30px; width: 90%; max-width: 400px; text-align: center; box-shadow: 0 0 25px rgba(255, 0, 51, 0.4); }
        h2 { color: #ff0033; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 0 10px #ff0033; }
        p { color: #aa5555; font-size: 14px; margin-bottom: 20px; }
        .owner-info { color: #ffcc00; font-size: 13px; margin-bottom: 15px; font-weight: bold; }
        input { width: 100%; padding: 12px; margin-bottom: 15px; background: #220508; border: 1px solid #ff0033; border-radius: 6px; color: #fff; text-align: center; font-size: 16px; outline: none; }
        button { width: 100%; padding: 12px; background: #ff0033; border: none; border-radius: 6px; color: #fff; font-weight: bold; font-size: 16px; cursor: pointer; transition: 0.3s; box-shadow: 0 0 12px #ff0033; }
        button:hover { background: #cc0029; box-shadow: 0 0 20px #ff0033; }
        #err { color: #ff6666; margin-top: 10px; font-size: 14px; display: none; }
      </style>
    </head>
    <body>
      <div class="login-card">
        <h2>❖ AFFAN TOOL ❖</h2>
        <div class="owner-info">OWNER: AFFAN | +91830799802</div>
        <p>Enter Red Edition Access Password</p>
        <input type="password" id="pass" placeholder="Enter Password">
        <button onclick="login()">UNLOCK SERVER</button>
        <div id="err">Incorrect Password!</div>
      </div>
      <script>
        async function login() {
          const pass = document.getElementById('pass').value;
          const res = await fetch('/api/verify-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pass })
          });
          const data = await res.json();
          if (data.success) {
            localStorage.setItem('affan_auth_token', data.token);
            document.cookie = "token=" + data.token + "; path=/";
            location.reload();
          } else {
            document.getElementById('err').style.display = 'block';
          }
        }
      </script>
    </body>
    </html>
  `);
});

app.use(
  express.static(
    path.join(__dirname, 'public')
  )
);


/* ================================
   DATABASE
================================ */

const db = new sqlite3.Database(
  path.join(__dirname, 'automation.db')
);

db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      phone TEXT,
      isConnected INTEGER DEFAULT 0,
      sentCount INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messageQueue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      target TEXT,
      prefix TEXT,
      message TEXT,
      speed INTEGER,
      isActive INTEGER DEFAULT 1,
      sentCount INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sentLogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT,
      target TEXT,
      message TEXT,
      sentAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

});


/* ================================
   MEMORY
================================ */

const sockets = {};
const pairingCodes = {};
const queueTimers = {};
const queueProcessing = {};
const connectingSessions = {};
const reconnectAttempts = {};


/* ================================
   PHONE CLEANER
================================ */

function cleanPhone(phone) {

  return String(phone || '')
    .replace(/\D/g, '');

}


/* ================================
   WHATSAPP CONNECTION
================================ */

async function connectWA(phone, sessionId) {

  if (connectingSessions[sessionId]) {
    return sockets[sessionId];
  }

  connectingSessions[sessionId] = true;

  try {

    const sessionPath = path.join(
      __dirname,
      'sessions',
      sessionId
    );

    if (!fs.existsSync(sessionPath)) {

      fs.mkdirSync(
        sessionPath,
        {
          recursive: true
        }
      );

    }


    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(
      sessionPath
    );


    const {
      version
    } = await fetchLatestBaileysVersion();


    const socket = makeWASocket({

      version,

      logger: pino({
        level: 'silent'
      }),

      browser:
        Browsers.windows('Chrome'),

      auth: state,

      printQRInTerminal: false,

      markOnlineOnConnect: true,

      keepAliveIntervalMs: 25000,

      connectTimeoutMs: 90000,

      retryRequestOptions: {
        maxRetries: 5
      }

    });


    sockets[sessionId] = socket;


    /* ================================
       SAVE CREDENTIALS
    ================================= */

    socket.ev.on(
      'creds.update',
      saveCreds
    );


    /* ================================
       CONNECTION UPDATE
    ================================= */

    socket.ev.on(
      'connection.update',
      async (update) => {

        const {
          connection,
          lastDisconnect
        } = update;


        if (
          connection === 'connecting'
        ) {

          console.log(
            chalk.red.bold(
              `🔴 [AFFAN] WhatsApp connecting... [ID: ${sessionId}]`
            )
          );

        }


        if (
          connection === 'open'
        ) {

          reconnectAttempts[sessionId] = 0;

          console.log(
            chalk.redBright.bold(
              `🔴✨ [AFFAN] WhatsApp CONNECTED SUCCESSFULLY! [ID: ${sessionId}]`
            )
          );


          db.run(
            `
            UPDATE sessions
            SET isConnected = 1
            WHERE id = ?
            `,
            [sessionId]
          );


          delete pairingCodes[
            sessionId
          ];


          delete connectingSessions[
            sessionId
          ];


          processQueue(
            sessionId
          );

        }


        if (
          connection === 'close'
        ) {

          console.log(
            chalk.bgRed.white.bold(
              ` ❌ [AFFAN] WhatsApp connection closed for [ID: ${sessionId}] `
            )
          );


          db.run(
            `
            UPDATE sessions
            SET isConnected = 0
            WHERE id = ?
            `,
            [sessionId]
          );


          delete sockets[
            sessionId
          ];


          delete connectingSessions[
            sessionId
          ];


          if (
            queueTimers[sessionId]
          ) {

            clearTimeout(
              queueTimers[sessionId]
            );

            delete queueTimers[
              sessionId
            ];

          }


          queueProcessing[
            sessionId
          ] = false;


          const attempts = (reconnectAttempts[sessionId] || 0) + 1;
          reconnectAttempts[sessionId] = attempts;
          const delayMs = Math.min(30000, attempts * 5000);

          console.log(
            chalk.red.bold(
              `⏳ [AFFAN] Auto-reconnecting session in ${delayMs / 1000}s (Attempt ${attempts})...`
            )
          );

          setTimeout(
            () => {

              connectWA(
                phone,
                sessionId
              ).catch(
                error => {

                  console.log(
                    chalk.red.bold(
                      `🚨 [AFFAN] Reconnect error:`
                    ),
                    error.message
                  );

                }
              );

            },
            delayMs
          );

        }

      }
    );


    /* ================================
       PAIRING CODE
    ================================= */

    if (
      !state.creds.registered
    ) {

      const number =
        cleanPhone(phone);


      if (!number) {

        pairingCodes[
          sessionId
        ] = {
          error:
            'Invalid phone number'
        };

      } else {

        console.log(
          chalk.red.bold(
            `🔻 [AFFAN] Preparing pairing code...`
          )
        );


        setTimeout(
          async () => {

            try {

              console.log(
                chalk.red.bold(
                  `🔻 [AFFAN] Generating pairing code...`
                )
              );


              const code =
                await socket.requestPairingCode(
                  number
                );


              pairingCodes[
                sessionId
              ] = code;


              console.log(
                chalk.red.bold(
                  `🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻`
                )
              );

              console.log(
                chalk.redBright.bold(
                  `🔑 AFFAN PAIRING CODE: ${code}`
                )
              );

              console.log(
                chalk.red.bold(
                  `🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺`
                )
              );


            } catch (error) {

              console.log(
                chalk.bgRed.white.bold(
                  ` 🚨 [AFFAN] Pairing code error: `
                ),
                error.message
              );


              pairingCodes[
                sessionId
              ] = {
                error:
                  error.message
              };

            }

          },
          3000
        );

      }

    }


    return socket;

  } catch (error) {

    delete connectingSessions[
      sessionId
    ];

    console.log(
      chalk.bgRed.white.bold(
        ` 🚨 [AFFAN] Connection error: `
      ),
      error.message
    );

    throw error;

  }

}


/* ================================
   LOGIN
================================ */

app.post(
  '/api/login',
  async (req, res) => {

    try {

      const phone =
        cleanPhone(
          req.body.phone
        );


      if (!phone) {

        return res.json({

          success: false,

          message:
            'Phone number required'

        });

      }


      const sessionId =
        `session_${Date.now()}`;


      db.run(
        `
        INSERT INTO sessions
        (id, phone, isConnected, sentCount)
        VALUES (?, ?, 0, 0)
        `,
        [
          sessionId,
          phone
        ]
      );


      await connectWA(
        phone,
        sessionId
      );


      res.json({

        success: true,

        sessionId,

        message:
          'Pairing code is being generated'

      });


    } catch (error) {

      console.error(error);


      res.json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/* ================================
   PAIRING CODE
================================ */

app.get(
  '/api/pairing-code/:sessionId',
  (req, res) => {

    const sessionId =
      req.params.sessionId;


    const code =
      pairingCodes[
        sessionId
      ];


    if (!code) {

      return res.json({

        success: false,

        status:
          'waiting'

      });

    }


    if (
      typeof code === 'object' &&
      code.error
    ) {

      return res.json({

        success: false,

        status:
          'error',

        message:
          code.error

      });

    }


    res.json({

      success: true,

      status:
        'ready',

      pairingCode:
        code

    });

  }
);


/* ================================
   START AUTOMATION
================================ */

app.post(
  '/api/start-automation',
  (req, res) => {

    const {
      sessionId,
      target,
      prefix = '',
      messages = [],
      speed = 5
    } = req.body;


    if (
      !sessionId ||
      !target ||
      !Array.isArray(messages) ||
      messages.length === 0
    ) {

      return res.json({

        success: false,

        message:
          'Missing automation data'

      });

    }


    const pending =
      messages.filter(
        message =>
          String(message).trim()
      );


    if (
      pending.length === 0
    ) {

      return res.json({

        success: false,

        message:
          'No valid messages'

      });

    }


    const delaySeconds =
      Math.max(
        1,
        Number(speed) || 5
      );


    pending.forEach(
      message => {

        db.run(
          `
          INSERT INTO messageQueue
          (
            sessionId,
            target,
            prefix,
            message,
            speed,
            isActive,
            sentCount
          )
          VALUES (?, ?, ?, ?, ?, 1, 0)
          `,
          [
            sessionId,
            String(target).trim(),
            prefix,
            String(message),
            delaySeconds
          ]
        );

      }
    );


    processQueue(
      sessionId
    );


    res.json({

      success: true,

      message:
        `${pending.length} message(s) added to queue`,

      delay:
        delaySeconds

    });

  }
);


/* ================================
   STOP AUTOMATION
================================ */

app.post(
  '/api/stop-automation',
  (req, res) => {

    const {
      sessionId
    } = req.body;


    if (!sessionId) {

      return res.json({

        success: false,

        message:
          'Session ID required'

      });

    }


    db.run(
      `
      UPDATE messageQueue
      SET isActive = 0
      WHERE sessionId = ?
      `,
      [sessionId]
    );


    if (
      queueTimers[sessionId]
    ) {

      clearTimeout(
        queueTimers[sessionId]
      );

      delete queueTimers[
        sessionId
      ];

    }


    queueProcessing[
      sessionId
    ] = false;


    res.json({

      success: true,

      message:
        'Automation stopped'

    });

  }
);


/* ================================
   QUEUE PROCESSOR
================================ */

async function processQueue(
  sessionId
) {

  if (
    queueProcessing[sessionId]
  ) {

    return;

  }


  queueProcessing[
    sessionId
  ] = true;

  const watchdog = setTimeout(() => {
    if (queueProcessing[sessionId]) {
      queueProcessing[sessionId] = false;
      processQueue(sessionId);
    }
  }, 45000);


  try {

    const socket =
      sockets[sessionId];


    if (!socket) {

      clearTimeout(watchdog);
      queueProcessing[
        sessionId
      ] = false;

      return;

    }


    db.get(
      `
      SELECT *
      FROM messageQueue
      WHERE sessionId = ?
      AND isActive = 1
      ORDER BY id ASC
      LIMIT 1
      `,
      [sessionId],
      async (
        error,
        item
      ) => {

        if (error) {

          console.log(
            chalk.red.bold(
              `🚨 [AFFAN] Queue database error:`
            ),
            error.message
          );

          clearTimeout(watchdog);
          queueProcessing[
            sessionId
          ] = false;

          return;

        }


        if (!item) {

          clearTimeout(watchdog);
          queueProcessing[
            sessionId
          ] = false;

          return;

        }


        try {

          const target =
            String(item.target || '').trim();


          if (!target) {

            db.run(
              `
              UPDATE messageQueue
              SET isActive = 0
              WHERE id = ?
              `,
              [item.id],
              () => {

                clearTimeout(watchdog);
                queueProcessing[
                  sessionId
                ] = false;

                processQueue(
                  sessionId
                );

              }
            );

            return;

          }


          const chatId =
            target.endsWith('@g.us')
              ? target
              : `${cleanPhone(target)}@s.whatsapp.net`;


          const fullMsg =
            `${item.prefix || ''} ${item.message}`
              .trim();


          console.log(
            chalk.red.bold(
              `🚀 [AFFAN] Sending message #${item.id} to ${target}...`
            )
          );


          await socket.sendMessage(
            chatId,
            {
              text: fullMsg
            }
          );


          console.log(
            chalk.redBright.bold(
              `🔴✨ [AFFAN] Message sent successfully!`
            )
          );


          db.run(
            `
            INSERT INTO sentLogs
            (
              sessionId,
              target,
              message
            )
            VALUES (?, ?, ?)
            `,
            [
              sessionId,
              target,
              fullMsg
            ]
          );


          db.run(
            `
            UPDATE sessions
            SET sentCount =
              sentCount + 1
            WHERE id = ?
            `,
            [sessionId]
          );


          db.run(
            `
            UPDATE messageQueue
            SET
              sentCount =
                sentCount + 1,
              isActive = 0
            WHERE id = ?
            `,
            [item.id],
            () => {

              clearTimeout(watchdog);
              queueProcessing[
                sessionId
              ] = false;


              const delaySeconds =
                Math.max(
                  1,
                  Number(item.speed) || 5
                );


              const delayMs =
                delaySeconds * 1000;


              console.log(
                chalk.red.bold(
                  `⏳ [AFFAN] Next message in ${delaySeconds} second(s)`
                )
              );


              queueTimers[
                sessionId
              ] = setTimeout(
                () => {

                  delete queueTimers[
                    sessionId
                  ];

                  processQueue(
                    sessionId
                  );

                },
                delayMs
              );

            }
          );


        } catch (error) {

          console.log(
            chalk.bgRed.white.bold(
              ` 🚨 [AFFAN] Message send error: `
            ),
            error.message
          );


          db.run(
            `
            UPDATE messageQueue
            SET isActive = 0
            WHERE id = ?
            `,
            [item.id],
            () => {

              clearTimeout(watchdog);
              queueProcessing[
                sessionId
              ] = false;


              queueTimers[
                sessionId
              ] = setTimeout(
                () => {

                  delete queueTimers[
                    sessionId
                  ];

                  processQueue(
                    sessionId
                  );

                },
                1000
              );

            }
          );

        }

      }
    );

  } catch (error) {

    console.log(
      chalk.bgRed.white.bold(
        ` 🚨 [AFFAN] Queue processor error: `
      ),
      error.message
    );


    queueProcessing[
      sessionId
    ] = false;

  }

}


/* ================================
   SESSIONS
================================ */

app.get(
  '/api/sessions',
  (req, res) => {

    db.all(
      `
      SELECT *
      FROM sessions
      ORDER BY rowid DESC
      `,
      [],
      (error, rows) => {

        if (error) {

          return res.json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          sessions:
            rows

        });

      }
    );

  }
);


/* ================================
   GROUPS
================================ */

app.get(
  '/api/groups/:sessionId',
  async (req, res) => {

    try {

      const sessionId =
        req.params.sessionId;


      const socket =
        sockets[sessionId];


      if (!socket) {

        return res.json({

          success: false,

          message:
            'WhatsApp session is not connected'

        });

      }


      const groups =
        await socket.groupFetchAllParticipating();


      const groupList =
        Object.values(groups || {})
          .map(group => ({

            id:
              group.id,

            subject:
              group.subject || 'Unnamed Group'

          }))
          .sort(
            (a, b) =>
              a.subject.localeCompare(
                b.subject
              )
          );


      res.json({

        success: true,

        groups:
          groupList

      });

    } catch (error) {

      console.log(
        chalk.red.bold(
          '🚨 [AFFAN] Group fetch error:'
        ),
        error.message
      );


      res.json({

        success: false,

        message:
          error.message

      });

    }

  }
);


/* ================================
   LOGS
================================ */

app.get(
  '/api/logs/:sessionId',
  (req, res) => {

    db.all(
      `
      SELECT *
      FROM sentLogs
      WHERE sessionId = ?
      ORDER BY id DESC
      LIMIT 100
      `,
      [
        req.params.sessionId
      ],
      (error, rows) => {

        if (error) {

          return res.json({

            success: false,

            message:
              error.message

          });

        }


        res.json({

          success: true,

          logs:
            rows

        });

      }
    );

  }
);


/* ================================
   HOME
================================ */

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );

  }
);


/* ================================
   SERVER
================================ */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log('');

    console.log(
      chalk.red.bold(
        '🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻🔻'
      )
    );

    console.log(
      chalk.redBright.bold(
        '          🔴  AFFAN AUTOMATION TOOL (RED EDITION)  🔴          '
      )
    );

    console.log(
      chalk.red.bold(
        '         🔥 OWNER NAME: AFFAN 🔥          '
      )
    );

    console.log(
      chalk.white.bold(
        '     📞 WHATSAPP / CONTACT: +91830799802     '
      )
    );

    console.log(
      chalk.redBright.bold(
        '     🔒 PASSWORD PROTECTED: AFFANMARK376     '
      )
    );

    console.log(
      chalk.red.bold(
        `       🌐 WHATSAPP SERVER ONLINE | PORT: ${PORT}`
      )
    );

    console.log(
      chalk.red.bold(
        '🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺🔺'
      )
    );

  }
);
