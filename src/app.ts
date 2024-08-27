import express, { Request, Response } from "express";
import path from "path";
import geoip from "geoip-lite";
import mysql from "mysql2/promise";
import { realIps } from "./realIPs";

const app = express();

// Set EJS as the templating engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static("public"));

app.use(express.json());

let connection: mysql.Connection;

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
    return res.render("index", {
      ip,

      guestbook: await getGuestbookPage(0, (await getIp(req)) as string),
    });
  } else {
    return res.render("add", {
      ip,
    });
  }
});

const populateDummy = async () => {
  let ii = 0;
  for (let j = 100; j < 200; j++) {
    for (let i = 100; i < 255; i++) {
      const countries = ["de", "br", "us", "ru", "fr", "es", "it", "jp", "cn"];

      const randomWords = [
        "Hi",
        "Hello",
        "Howdy",
        "Yo",
        "Hey",
        "Yo",
        "App",
        "Apple",
        "Can",
        "Take",
        "have",
        "your",
        "name",
        "please",
      ];
      const checkSql = `SELECT * FROM guestbook WHERE ip = ?`;

      const [results] = await connection.query(checkSql, [`19.214.${i}.${j}`]);
      if ((results as any[]).length > 0) {
        continue;
      }

      const sql = `INSERT INTO guestbook (ip, countryCode, message) VALUES (?, ?, ?)`;

      const nRandomWords = (n: number) => {
        const words = [];
        for (let i = 0; i < n; i++) {
          words.push(
            randomWords[Math.floor(Math.random() * randomWords.length)]
          );
        }
        return words.join(" ").slice(0, 256);
      };

      const result = await connection.query(sql, [
        `19.214.${i}.${j}`,
        countries[Math.floor(Math.random() * countries.length)],
        ii++ + nRandomWords(Math.floor(Math.random() * 100) + 1),
      ]);

      // console.log(result);
    }
  }
};

app.get("/page/:page(\\d+)", async (req: Request, res: Response) => {
  const page = parseInt(req.params.page);

  return res.render("page", {
    guestbook: await getGuestbookPage(page, (await getIp(req)) as string),
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

  var geo = geoip.lookup(ip as string);

  if (!geo) {
    return res.status(400).json({ error: "Weird IP provided" });
  }

  if (await hasSigned(ip)) {
    return res.status(200).json({ success: true });
  }

  const countryCode = geo?.country.toLowerCase();

  console.log(`[${ip}] ${countryCode} ${message}`);

  await addToDb(ip, countryCode, message);

  return res.status(200).json({ success: true });
});

const getIp = async (req: Request) => {
  let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

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

const addToDb = async (ip: string, countryCode: string, message?: string) => {
  try {
    const sql = `INSERT INTO guestbook (ip, countryCode, message) VALUES (?, ?, ?)`;
    const result = await connection.query(sql, [ip, countryCode, message]);
  } catch (error: any) {
    if (error.code === "ER_DUP_ENTRY") {
    }
  }
};

const getGuestbookPage = async (page: number, ip: string) => {
  console.log(`page ${page} ip ${ip}`);
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
  return result[0];
};

const initDb = async () => {
  connection = await mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "password",
    database: "guestbook",
  });

  const sql = `CREATE TABLE IF NOT EXISTS guestbook (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ip VARCHAR(45) UNIQUE NOT NULL,
    countryCode CHAR(2) NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    message VARCHAR(1000),
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
