// Fixture: intentionally insecure code used to test the SAST workflow.
import express from "express";

const app = express();

app.get("/run", (req, res) => {
  const userInput = req.query.code as string;
  res.send(String(eval(userInput)));
});

export default app;
