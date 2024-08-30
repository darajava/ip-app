import express, { Request, Response } from "express";
import path from "path";
import geoip from "geoip-lite";
import mysql, { RowDataPacket } from "mysql2/promise";
import { realIps } from "./realIPs";
import { broadcast, wss } from "./websocket";
import ejs from "ejs";
import { OpenAI } from "openai";

// nodemon nonsense
process.on("SIGTERM", async () => {
  wss.close();
  setTimeout(() => process.exit(0), 3000);
});

const app = express();

// Set EJS as the templating engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));

app.use(express.json());
app.set("trust proxy", "loopback");

let connection: mysql.Connection;

setInterval(async () => {
  const random1 = Math.floor(Math.random() * 255);
  const random2 = Math.floor(Math.random() * 255);
  const random3 = Math.floor(Math.random() * 255);
  const random4 = Math.floor(Math.random() * 255);
  addRandomEntry(`${random1}.${random2}.${random3}.${random4}`);
}, 1000);

app.get("/banned", async (req: Request, res: Response) => {
  const ip = await getIp(req);

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

app.get("/", async (req: Request, res: Response) => {
  const ip = await getIp(req);

  if (!ip) {
    return res.status(400).json({ error: "No IP provided" });
  }

  // await populateDummy();

  // if (await hasSigned(ip)) {
  //   const removeSql = `DELETE FROM guestbook WHERE ip = ?`;
  //   await connection.query(removeSql, [ip]);
  // }

  if (await hasSigned(ip)) {
    console.log(
      "already signed",
      await getGuestbookPage(0, (await getIp(req)) as string)
    );
    return res.render("index", {
      ip,
      guestbook: await getGuestbookPage(0, (await getIp(req)) as string),
    });
  } else {
    return res.render("add", {
      ip,
      countryCode: await getCountryCode(ip),
    });
  }
});

const populateDummy = async () => {
  let ii = 0;
  for (let j = 100; j < 101; j++) {
    for (let i = 100; i < 255; i++) {
      await addRandomEntry(`19.214.${i}.${j}`);

      // console.log(result);
    }
  }
};

const addRandomEntry = async (ip: string) => {
  const countries = ["de", "br", "us", "ru", "fr", "es", "it", "jp", "cn"];

  function generateRandomSentence(): string {
    const subjects = [
      "The cat",
      "A dog",
      "The bird",
      "A monkey",
      "An astronaut",
      "A programmer",
    ];
    const verbs = ["jumps", "runs", "flies", "writes", "eats", "builds"];
    const objects = [
      "over the moon",
      "in the park",
      "towards the tree",
      "a novel",
      "a sandwich",
      "a website",
    ];

    // Generate random indices
    const subjectIndex = Math.floor(Math.random() * subjects.length);
    const verbIndex = Math.floor(Math.random() * verbs.length);
    const objectIndex = Math.floor(Math.random() * objects.length);

    // Form the sentence
    let sentence = `${subjects[subjectIndex]} ${verbs[verbIndex]} ${objects[objectIndex]}.`;

    return sentence;
  }

  function sentenceOfLength(length: number): string {
    let sentence = "";
    for (let i = 0; i < length; i++) {
      sentence += " " + generateRandomSentence();
    }
    return sentence.substring(0, length);
  }

  const checkSql = `SELECT * FROM guestbook WHERE ip = ? and hidden = 0`;

  const [results] = await connection.query(checkSql, [ip]);
  if ((results as any[]).length > 0) {
    return;
  }

  await addToDb(
    ip,
    countries[Math.floor(Math.random() * countries.length)],
    sentenceOfLength(Math.floor(Math.random() * 256)),
    false,
    "hi"
  );
};

app.get("/page/:page(\\d+)", async (req: Request, res: Response) => {
  const page = parseInt(req.params.page);

  const guestbook = await getGuestbookPage(page, (await getIp(req)) as string);

  if (!guestbook.length) {
    return res.status(200).send("end");
  }

  return res.render("page", {
    guestbook,
    ip: await getIp(req),
  });
});

app.post("/add", async (req: Request, res: Response) => {
  const ip = await getIp(req);
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

  const bannedInfo = await isBanned(message);

  await addToDb(ip, countryCode, message, bannedInfo.banned, bannedInfo.reason);

  return res.status(200).json({ banned: bannedInfo.banned, success: true });
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

const isBanned = async (message: string) => {
  const resp = await openai.chat.completions.create({
    messages: [
      {
        role: "user",
        content: `
        We asked the user to supply a message for display in a public guestbook.

        If the user writes in a language other than English, the reason must be provided in that language.

        The message supplied was: "${message}"

        The message must be interesting AND must not contain profanity AND not be nonsensical AND have good grammar and spelling. Above all, it should be interesting and original for it to be suitable for the guestbook.

        Reply in JSON format with the following fields:

        {
          "suitable": true | false,
          "interesting": true | false,
          "inputLanguage": // language of the message given
          "reason": // reason for the verdict. Be harsh. Don't tell them to try again because they will be banned.
        }

        do not return a string in the suitable field, return true or false in bool format


        Examples of uninteresting messages:

        I had a lot of chores to do today and I did them all.
        
        I woke up and went to work, then I came home and watched netflix and then I went to bed.



        Examples of interesting messages:

        I will never again talk about politics with my friends or family. It's pointless and can ruin relationships.
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

  let gptInfo = JSON.parse(resp.choices[0].message.content);
  console.log(gptInfo);
  return {
    banned: !gptInfo.suitable,
    reason: gptInfo.reason,
  };
};

const getCountryCode = async (ip: string) => {
  var geo = geoip.lookup(ip as string);

  const countryCode = geo?.country.toLowerCase();
  return countryCode;
};

const getIp = async (req: Request) => {
  let ip = req.socket.remoteAddress;

  if (Array.isArray(ip)) {
    ip = ip[0];
  }

  if (ip === "::1") {
    ip = realIps[1];
  }

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
  reason: string
) => {
  try {
    await connection.query(
      `INSERT INTO guestbook (ip, countryCode, message, hidden, reason) VALUES (?, ?, ?, ?, ?)`,
      [ip, countryCode, message, banned, reason]
    );

    if (!!reason) {
      return;
    }

    const [justInserted] = (await connection.query(
      `SELECT * FROM guestbook WHERE ip = ?`,
      [ip]
    )) as any[];

    broadcast({
      action: "entryAdded",
      messageJSON: JSON.stringify({
        html: await ejs.renderFile(path.join("./src/views", "entry.ejs"), {
          entry: justInserted[0],
          ip: "null",
        }),
      }),
    });
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
      WHERE hidden = 0
      ORDER BY id DESC
      LIMIT ${pageSize} OFFSET ${offset}
  ) subquery
  ORDER BY id ASC;`;

  console.log(sql);
  const result = await connection.query(sql);

  console.log(result);

  return result[0] as any[];
};

const initDb = async () => {
  connection = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password: process.env.DB_PASS,
    database: "guestbook",
  });

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
};

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await initDb();

  console.log(`Server started on port ${PORT}`);
});
