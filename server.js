require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL }));
app.use(express.json());

// Google Auth Setup
const oauthClient = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

// Google Sheets Service Account Auth
const serviceAccountAuth = new google.auth.GoogleAuth({
  credentials: {
    type: "service_account",
    project_id: process.env.GOOGLE_PROJECT_ID,
    private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID,
    private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    client_id: process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_ID,
    token_url: "https://oauth2.googleapis.com/token",
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth: serviceAccountAuth });
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// Utility Functions

// Timestamp
const currentDateTime = () => {
  const dateObject = new Date();
  return new Date(dateObject).toLocaleString("en-US", {
    timeZone: "Asia/Jakarta",
    hour12: true,
  });
};

// // Get last row number from a given range
const getLastRowNumber = async (range) => {
  try {
    // Get the last row number from MAIN_DATA sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
    });
    if (!response.data.values || response.data.values.length === 0) {
      return 0; // No rows found
    }
    const rows = response.data.values.length || null;
    const rowNumber = response.data.values[rows - 1]?.[0] || null;
    // Return the last row number
    return parseInt(rowNumber, 10) || 1; // Ensure it's a number
  } catch (error) {
    console.error("Error getting last row number:", error);
    // If there's an error, return 0
    return 0;
  }
};

// Verify Google Token and Authenticate User
app.post("/auth/google", async (req, res) => {
  try {
    const { token } = req.body;
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    console.log("Google auth ticket:", ticket);
    console.log("Google auth payload:", ticket.getPayload());
    console.log("Google auth credentials:", token);

    const payload = ticket.getPayload();
    const user = {
      email: payload.email,
      name: payload.name,
      googleId: payload.sub,
    };

    // Sync user with USER_LIST sheet
    const userSheet = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "USER_LIST!A2:G",
    });

    const users = userSheet.data.values || [];
    const userIndex = users.findIndex((u) => u[2] === user.email);

    // Create JWT session token
    const sessionToken = jwt.sign(
      { email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "1h" }
    );
    console.log(sessionToken);

    if (userIndex === -1) {
      // Add new user
      users.push([user.name, credentials, sessionToken, "user"]);
    } else {
      // Update existing user
      users[userIndex][1] = user.name; // Update name
      users[userIndex][3] = token; // Update credentials
      users[userIndex][4] = sessionToken; // Update session token
      users[userIndex][5] = "user"; // Update role
    }

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: "USER_LIST!A2:G",
      valueInputOption: "RAW",
      resource: { values: users },
    });

    await logActivity(user, "LOGIN", "User Login Attempt");

    res.json({
      token: sessionToken,
      user: {
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(401).json({ error: "Authentication failed" });
  }
});

// Middleware to verify JWT
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  try {
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Check if the token is expired
    const currentTime = Math.floor(Date.now() / 1000);
    if (decoded.exp < currentTime) {
      res.status(401).json({ error: "Token Expired" });
    }
    req.user = decoded;
    console.log("Authenticated user:", req.user);
    next();
  } catch (error) {
    res.status(401).json({ error: "Token Expired" });
  }
};

app.post("/authenticate", authenticate, (req, res) => {
  res.json({ message: "Authenticated successfully", user: req.user });
});

// Log Activity Helper
const logActivity = async (user, action, details) => {
  try {
    const newRowNumber = (await getLastRowNumber("LOG_ACTIVITY!A2:A")) + 1;
    const logEntry = [
      newRowNumber,
      user.name,
      user.email,
      action,
      JSON.stringify(details),
      currentDateTime(),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "LOG_ACTIVITY!A2:F",
      valueInputOption: "RAW",
      resource: { values: [logEntry] },
    });
  } catch (error) {
    console.error("Failed to log activity, Server Error!");
    throw new Error("Server Error!");
  }
};

// CRUD Operations for MAIN_DATA
// Get all entries
app.get("/data", authenticate, async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "MAIN_DATA!A2:K",
    });

    const rows = response.data.values || [];
    const data = rows.map((row) => ({
      id: row[0],
      fullName: row[1],
      populationId: row[2],
      familyId: row[3],
      gender: row[4],
      dateOfBirth: row[5],
      placeOfBirth: row[6],
      religion: row[7],
      bloodType: row[8],
      lastUpdated: row[9],
    }));

    res.json(data);
  } catch (error) {
    console.error("Error fetching data:", error);
    res.status(500).json({ error: "Failed to fetch data" });
  }
});

// Create new entry
app.post("/data/entry", authenticate, async (req, res) => {
  try {
    const newRowNumber = (await getLastRowNumber("MAIN_DATA!A2:A")) + 1;
    const newData = req.body;
    console.log("New data to create:", newData);
    const newRow = [
      newRowNumber,
      newData.fullName,
      newData.populationId,
      newData.familyId,
      newData.gender,
      newData.dateOfBirth,
      newData.placeOfBirth,
      newData.religion,
      newData.bloodType,
      "active",
      currentDateTime(),
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "MAIN_DATA!A2:K",
      valueInputOption: "USER_ENTERED",
      resource: { values: [newRow] },
    });

    // Log activity
    await logActivity(req.user, "CREATE", { data: newData });

    res
      .status(201)
      .json({ message: "Entry created successfully", data: newRow });
    console.log("New entry created:", newRow);
  } catch (error) {
    console.error("Error creating entry:", error);
    res.status(500).json({ error: "Failed to create entry" });
  }
});

// Update existing entry
app.put("/dataupdate/:id", authenticate, async (req, res) => {
  try {
    const id = req.params.id;
    const updatedData = req.body;
    console.log("Data to update:", updatedData);

    // Get all data to find row index
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "MAIN_DATA!A2:K",
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row) => row[0] === id);

    if (rowIndex === -1) {
      return res.status(404).json({ error: "Entry not found" });
    }

    // Prepare updated row
    const updatedRow = [
      id,
      updatedData.fullName,
      updatedData.populationId,
      updatedData.familyId,
      updatedData.gender,
      updatedData.dateOfBirth,
      updatedData.placeOfBirth,
      updatedData.religion,
      updatedData.bloodType,
      "active",
      currentDateTime(),
    ];

    console.log("Updated row data:", updatedRow);

    // Update specific row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `MAIN_DATA!A${rowIndex + 2}:K${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: [updatedRow] },
    });

    // Log activity
    await logActivity(req.user, "UPDATE", { id, updates: updatedData });

    res.json({ message: "Entry updated successfully" });
  } catch (error) {
    console.error("Error updating entry:", error);
    res.status(500).json({ error: "Failed to update entry" });
  }
});

// Delete entry
app.put("/data/:id", authenticate, async (req, res) => {
  try {
    const id = req.params.id;

    // Get all data to find row index
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "MAIN_DATA!A2:K",
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex((row) => row[0] === id);

    if (rowIndex === -1) {
      return res.status(404).json({ error: "Entry not found" });
    }

    // Update specific row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `MAIN_DATA!K${rowIndex + 2}`,
      valueInputOption: "USER_ENTERED",
      resource: { values: "tidak aktif" },
    });

    // Log activity
    await logActivity(req.user, "DELETE", { id });

    res.json({ message: "Entry deleted successfully" });
  } catch (error) {
    console.error("Error deleting entry:", error);
    res.status(500).json({ error: "Failed to delete entry" });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Spreadsheet ID: ${SPREADSHEET_ID}`);
});
