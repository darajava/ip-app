import express, { Request, Response } from "express";
import path from "path";

const app = express();

// Set EJS as the templating engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Define routes
app.get("/", (req: Request, res: Response) => {
  res.render("index", { title: "My Website", message: "Hello, world!" });
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
