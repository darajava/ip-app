import express, { Request, Response } from "express";
import path from "path";
import geoip from "geoip-lite";
import mysql, { RowDataPacket } from "mysql2/promise";
import { realIps } from "./realIPs";
import { broadcast, wss } from "./websocket";
import ejs from "ejs";
import { OpenAI } from "openai";
const ipfilter = require("express-ipfilter").IpFilter;

require("dotenv").config();

// nodemon nonsense
process.on("SIGTERM", async () => {
  wss.close();
  setTimeout(() => process.exit(0), 3000);
});
const ips = [] as string[];

// Create the server

const app = express();

app.use(ipfilter(ips));
// Set EJS as the templating engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));

app.use(express.json());
app.set("trust proxy", "loopback");

let connection: mysql.Connection;

// setInterval(async () => {
//   const random1 = Math.floor(Math.random() * 255);
//   const random2 = Math.floor(Math.random() * 255);
//   const random3 = Math.floor(Math.random() * 255);
//   const random4 = Math.floor(Math.random() * 255);
//   addRandomEntry(`${random1}.${random2}.${random3}.${random4}`);
// }, 1000);

const addRandomEntry = async (ip: string) => {
  addToDb(
    ip,
    "de",
    "Random entry" + ip,
    false,
    "Random entry added by the bot"
  );
};

app.get("/banned", async (req: Request, res: Response) => {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  const bannedSql = `SELECT * FROM guestbook WHERE ip = ?`;
  const [banned] = (await connection.query(bannedSql, [ip])) as any[];

  if (!banned[0]) {
    return res.redirect("/");
  }

  return res.render("banned", {
    message: banned[0].message,
    reason: banned[0].reason,
    ip,
  });
});

app.put("/toggle/:ipToToggle", async (req: Request, res: Response) => {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  if (!(await isAdmin(ip))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const ipToToggle = req.params.ipToToggle;
  if (!ipToToggle) {
    return res.status(400).json({ error: "No IP to toggle provided" });
  }

  const toggleSql = `UPDATE guestbook SET hidden = NOT hidden WHERE ip = ?`;
  await connection.query(toggleSql, [ipToToggle]);

  return res.status(200).json({ success: true });
});

app.delete("/delete/:ipToDelete", async (req: Request, res: Response) => {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  if (!(await isAdmin(ip))) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const ipToDelete = req.params.ipToDelete;
  if (!ipToDelete) {
    return res.status(400).json({ error: "No IP to toggle provided" });
  }

  const deleteSql = `DELETE FROM guestbook WHERE ip = ?`;
  await connection.query(deleteSql, [ipToDelete]);

  return res.status(200).json({ success: true });
});

app.get("/", async (req: Request, res: Response) => {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  // await populateDummy();

  // if (await hasSigned(ip)) {
  //   const removeSql = `DELETE FROM guestbook WHERE ip = ?`;
  //   await connection.query(removeSql, [ip]);
  // }

  if (await hasSigned(ip)) {
    if (await isBanned(ip)) {
      return res.redirect("/banned");
    }

    return res.render("index", {
      ip,
      guestbook: await getGuestbookPage(0, getIp(req) as string),
      isAdmin: await isAdmin(ip),
    });
  } else {
    return res.render("add", {
      ip,
      countryCode: await getCountryCode(ip),
    });
  }
});

app.get("/guestbook", async (req: Request, res: Response) => {
  const ip = getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  return res.render("index", {
    ip,
    isAdmin: await isAdmin(ip),
    guestbook: await getGuestbookPage(0, getIp(req) as string),
  });
});

app.get("/page/:page(\\d+)", async (req: Request, res: Response) => {
  const page = parseInt(req.params.page);

  const guestbook = await getGuestbookPage(page, getIp(req) as string);

  if (!guestbook.length) {
    return res.status(200).send("end");
  }

  const ip = getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  return res.render("page", {
    guestbook,
    ip,
    isAdmin: await isAdmin(ip),
  });
});

app.post("/add", async (req: Request, res: Response) => {
  const ip = getIp(req);
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "No message provided" });
  }

  if (message.length > 256) {
    return res.status(400).json({ error: "Message too long" });
  }

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  if (await hasSigned(ip)) {
    return res.status(200).json({ success: true });
  }

  const countryCode = await getCountryCode(ip);

  if (!countryCode) {
    return res.status(400).json({ error: "Weird IP provided" });
  }

  const bannedInfo = await isMessageSuitable(message);

  await addToDb(
    ip,
    countryCode,
    message,
    bannedInfo.banned,
    bannedInfo.reason,
    req
  );

  return res.status(200).json({ banned: bannedInfo.banned, success: true });
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

const isMessageSuitable = async (message: string) => {
  const resp = await openai.chat.completions.create({
    messages: [
      {
        role: "user",
        content: `
        We asked the user to supply a message for display in a public guestbook.

        The message supplied was: "${message}"
        
        The message must be interesting AND must not contain profanity AND not be nonsensical AND have good grammar and spelling. Above all, it should be interesting and original for it to be suitable for the guestbook.

        It doesn't need perfect spelling and it doesn't need perfect grammar. Reject if it has TERRIBLE spelling or grammar.

        It doesn't necessarily need to be positive.

        Determine if it's suitable for my guestbook.
        
        Reply in JSON format with the following fields:
        
        {
          "suitable": // true | false
          "reason": // reason for the verdict. Be harsh if not suitable. Don't tell them to try again because they will be banned. Don't refer to the original message. If it is suitable, be nice.
          "inputLanguage": // language of the message given
          }

          If the user writes in a language other than English, the reason must be provided in that language.
          
          do not return a string in the suitable field, return true or false in bool format
          

        Examples of uninteresting messages:

        I had a lot of chores to do today and I did them all.
        
        I woke up and went to work, then I came home and watched netflix and then I went to bed.

        Hi there honey.

        ---------------

        Examples of interesting messages:

        I will never again talk about politics with my friends or family. It's pointless and can ruin relationships.
        
        Look around and pick one beautiful thing about your surroundings. We are so lucky to be here!

        Goodbye ip, you made a great home for 6 years. So much YouTube watched through you

        I learned that in the pursuit of success, you need to work hard. But by working hard the most rewarding thing that is gained is in fact the ability to work hard. I’ve learned that hard work is a great feeling and that is my success.
        `,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 100,
    model: "gpt-4o-mini",
  });

  if (!resp.choices[0].message.content) {
    console.log("No response from openai");
    return {
      banned: false,
    };
  }

  console.log(resp.choices[0].message.content);

  let gptInfo = JSON.parse(resp.choices[0].message.content);
  return {
    banned: !gptInfo.suitable,
    reason: gptInfo.reason,
  };
};

const isBanned = async (ip: string) => {
  const sql = `SELECT * FROM guestbook WHERE ip = ? and hidden = 1`;
  const [results] = await connection.query(sql, [ip]);

  if ((results as any[]).length > 0) {
    return true;
  }
};

export const isAdmin = async (ip: string) => {
  const sql = `SELECT * FROM adminIps WHERE ip = ?`;
  const [results] = await connection.query(sql, [ip]);

  if ((results as any[]).length > 0) {
    return true;
  }

  return false;
};

const getCountryCode = async (ip: string) => {
  var geo = geoip.lookup(ip as string);

  const countryCode = geo?.country.toLowerCase();
  return countryCode;
};

const getIp = (req: Request) => {
  let ip = req.headers["x-real-ip"] || req.socket.remoteAddress;

  if (Array.isArray(ip)) {
    ip = ip[0];
  }

  if (ip === "::1") {
    ip = realIps[1];
    ip = realIps[2];
  }

  ip = ip?.replace("::ffff:", "");

  return ip;
};

const hasSigned = async (ip: string) => {
  const sql = `SELECT * FROM guestbook WHERE ip = ?`;
  const [results] = await connection.query(sql, [ip]);

  if ((results as any[]).length > 0) {
    return true;
  }

  return false;
};

const addToDb = async (
  ip: string,
  countryCode: string,
  message: string,
  banned: boolean,
  reason: string,
  req?: Request
) => {
  try {
    await connection.query(
      `INSERT INTO guestbook (ip, countryCode, message, hidden, reason) VALUES (?, ?, ?, ?, ?)`,
      [ip, countryCode, message, banned, reason]
    );

    const [justInserted] = (await connection.query(
      `SELECT * FROM guestbook WHERE ip = ?`,
      [ip]
    )) as any[];

    broadcast(
      {
        action: "entryAdded",
        messageJSON: JSON.stringify({
          html: await ejs.renderFile(path.join("./src/views", "entry.ejs"), {
            entry: justInserted[0],
            ip: req ? getIp(req) || "0.0.0.0" : "0.0.0.0",
          }),
        }),
      },
      justInserted[0].hidden
    );
  } catch (error: any) {
    console.log(error);
  }
};

const getGuestbookPage = async (page: number, ip: string) => {
  const pageSize = 100;
  const offset = Math.abs(page * pageSize);

  const sql = `SELECT *
  FROM (
      SELECT *
      FROM guestbook
      ORDER BY id DESC
      LIMIT ${pageSize} OFFSET ${offset}
  ) subquery
  ORDER BY id ASC;`;

  const result = await connection.query(sql);

  return result[0] as any[];
};

const initDb = async () => {
  console.log("Connected to MySQL", process.env.DB_PASS);
  try {
    connection = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: process.env.DB_PASS,
      database: "guestbook",
      port: 3306,
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  const sql = `CREATE TABLE IF NOT EXISTS guestbook (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip VARCHAR(45) UNIQUE NOT NULL,
    countryCode CHAR(2) NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    message VARCHAR(1000),
    hidden TINYINT(1) NOT NULL DEFAULT 0,
    reason VARCHAR(1000) DEFAULT NULL,
    INDEX (ip)
  );`;

  await connection.query(sql);

  const sql2 = `CREATE TABLE IF NOT EXISTS adminIps (ip VARCHAR(45) UNIQUE NOT NULL);`;

  await connection.query(sql2);
};

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDb();

  console.log(`Server started on port ${PORT}`);
});
