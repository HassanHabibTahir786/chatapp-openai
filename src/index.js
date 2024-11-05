import "dotenv/config";
import express, { json } from "express";
import { serverError } from "./middleware/handleErrors.js";
import cors from "cors";
import { OpenAI } from "openai";
import fileUpload from "express-fileupload";
import fs from "fs";
import { getStoragePath, getStoreFile } from "./utils/storage.js";
const app = express();
app.use(cors());
app.use(express.json({ limit: "1gb" }));
app.use(
  express.urlencoded({ limit: "1gb", extended: false, parameterLimit: 1000000 })
);
app.use(fileUpload());

const { PORT } = process.env;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function uploadFilesToVectorStore(name) {
  try {
    const filePaths = await getStoreFile(name);
    const fileStreams = filePaths.map((path) => {
      if (!fs.existsSync(path)) {
        throw new Error(`File does not exist at path: ${path}`);
      }
      return fs.createReadStream(path);
    });

    let vectorStore = await openai.beta.vectorStores.create({
      name: name,
    });
    const uploadResponse =
      await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStore.id, {
        files: fileStreams,
      });
    return uploadResponse;
  } catch (error) {
    console.error("Error uploading file:", error);
  }
}

// Run the function

app.post("/upload-file", async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).send("No files were uploaded.");
    }
    const uploadedFile = req.files.file;
    let profileImage;
    let storagePath;
    if (uploadedFile) {
      storagePath = getStoragePath(uploadedFile);
      await uploadedFile.mv(storagePath);
      profileImage = uploadedFile?.name;
    }
    const fileId = await uploadFilesToVectorStore(profileImage);
    console.log("File ID:", fileId);
    const assistant = await openai.beta.assistants.create({
      name: "file assistants",
      description: "you  answer from the file it is attached",
      model: "gpt-4o-mini",
      tools: [
        { type: "file_search" },
        {
          type: "code_interpreter",
        },
      ],
      tool_resources: {
        file_search: {
          vector_store_ids: [fileId?.vector_store_id],
        },
      },
    });
    res.status(200).json({ assistantId: assistant?.id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: error.message });
    return;
  }
});

const threadByUser = {};
app.post("/assistent", async (req, res) => {
  if (!req.body?.assistentId) {
    res.status(400).json({ message: "Assistant ID is required" });
    return;
  }
  const assistantIdToUse = req.body?.assistentId;
  const modelToUse = "gpt-4o-mini";
  const userId = "67220f90644649c7d03e2fc0";

  if (!threadByUser[userId]) {
    try {
      const myThread = await openai.beta.threads.create();
      console.log("New thread created with ID: ", myThread.id, "\n");
      threadByUser[userId] = myThread.id;
    } catch (error) {
      console.error("Error creating thread:", error);
      res.status(500).json({ error: "Internal server error" });
      return;
    }
  }

  const userMessage = req.body.message;

  try {
    const myThreadMessage = await openai.beta.threads.messages.create(
      threadByUser[userId],
      {
        role: "user",
        content: userMessage,
      }
    );
    const myRun = await openai.beta.threads.runs.create(
      threadByUser[userId], // Use the stored thread ID for this user
      {
        model:modelToUse,
        assistant_id: assistantIdToUse,
        instructions:
          "you answer only 50 words from the file. ",
        tools: [
          { type: "file_search" },
          // { type: "retrieval" }, // Retrieval tool
        ],
      }
    );
    const retrieveRun = async () => {
      let keepRetrievingRun;

      while (myRun.status !== "completed") {
        keepRetrievingRun = await openai.beta.threads.runs.retrieve(
          threadByUser[userId], // Use the stored thread ID for this user
          myRun.id
        );
        console.log(`Run status: ${(keepRetrievingRun?.status)}`);
        if (keepRetrievingRun.status === "completed") {
          console.log("\n");
          break;
        }
      }
    };
    retrieveRun();
    const waitForAssistantMessage = async () => {
      await retrieveRun();

      const allMessages = await openai.beta.threads.messages.list(
        threadByUser[userId] // Use the stored thread ID for this user
      );

      // Send the response back to the front end
      res.status(200).json({
        response: allMessages.data[0].content[0].text.value,
      });
      console.log(
        "------------------------------------------------------------ \n"
      );

    };
    waitForAssistantMessage();
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const main = async () => {
  const server = app.listen(PORT, async () => {
    console.log(`Server Running On Port ${PORT}`);
  });
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
app.use(serverError);
