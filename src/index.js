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
    return filePaths.map((path) => {
      if (!fs.existsSync(path)) {
        throw new Error(`File does not exist at path: ${path}`);
      }
      return fs.createReadStream(path);
    });
  } catch (error) {
    console.error("Error uploading file:", error);
    throw error;
  }
}

// Helper function to get file streams from uploaded files
async function getFileStreams(uploadedFiles) {
  const fileStreams = [];
  for (const file of uploadedFiles) {
    const storagePath = getStoragePath(file);
    await file.mv(storagePath);
    const streams = await uploadFilesToVectorStore(file.name);
    fileStreams.push(...streams);
  }
  return fileStreams;
}

// Helper function to create or update a vector store
async function getOrCreateVectorStore(assistantId) {
  let vectorStoreId;

  if (assistantId) {
    const existingAssistant = await openai.beta.assistants.retrieve(assistantId);
    if (existingAssistant.tool_resources.file_search.vector_store_ids.length > 0) {
      vectorStoreId = existingAssistant.tool_resources.file_search.vector_store_ids[0];
    } else {
      const newVectorStore = await openai.beta.vectorStores.create({ name: 'assistantFilesForChat' });
      vectorStoreId = newVectorStore.id;
      await openai.beta.assistants.update(assistantId, {
        tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
      });
    }
  } else {
    const newVectorStore = await openai.beta.vectorStores.create({ name: 'assistantFilesForChat' });
    vectorStoreId = newVectorStore.id;
  }

  return vectorStoreId;
}
// Route for uploading files to an existing assistant
app.post("/upload-on-existing-assistant", async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files.file).length === 0) {
      return res.status(400).send("No files were uploaded.");
    }
   if(!req.body.assistantId){
     return res.status(400).send("Assistant ID is required");
   }
    const uploadedFiles = Array.isArray(req.files.file) ? req.files.file : [req.files.file];
    const fileStreams = await getFileStreams(uploadedFiles);

    const assistantId = req.body.assistantId;
    const vectorStoreId = await getOrCreateVectorStore(assistantId);

    await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, { files: fileStreams });

    res.status(200).json({
      message: "Files uploaded and added to existing assistant's vector store.",
      assistantId,
    });
  } catch (error) {
    console.error("Error uploading files:", error);
    res.status(500).json({ message: error.message });
  }
});


// Route for first-time file upload and assistant creation
app.post("/upload-first-time", async (req, res) => {
  try {
    if (!req.files || Object.keys(req.files.file).length === 0) {
      return res.status(400).send("No files were uploaded.");
    }

    const uploadedFiles = Array.isArray(req.files.file) ? req.files.file : [req.files.file];
    const fileStreams = await getFileStreams(uploadedFiles);

    const newVectorStore = await openai.beta.vectorStores.create({ name: 'assistantFilesForChat' });
    await openai.beta.vectorStores.fileBatches.uploadAndPoll(newVectorStore.id, { files: fileStreams });

    const assistant = await openai.beta.assistants.create({
      name: "file assistants",
      description: "you answer from the file it is attached under 50 words",
      model: "gpt-4o-mini",
      tools: [
        { type: "file_search" },
        { type: "code_interpreter" },
      ],
      tool_resources: { file_search: { vector_store_ids: [newVectorStore.id] } },
    });

    res.status(200).json({
      message: "New assistant created with uploaded files.",
      assistantId: assistant.id,
    });
  } catch (error) {
    console.error("Error creating assistant:", error);
    res.status(500).json({ message: error.message });
  }
});




const threadByUser = {};
app.post("/assistent", async (req, res) => {
  if (!req.body?.assistentId) {
    res.status(400).json({ message: "Assistant ID is required" });
    return;
  }
  if(!req.body.message){
    res.status(400).json({ message: "Message is required" });
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

// async function uploadFilesToVectorStore(name) {
//   try {
//     const filePaths = await getStoreFile(name);
//     const fileStreams = filePaths.map((path) => {
//       if (!fs.existsSync(path)) {
//         throw new Error(`File does not exist at path: ${path}`);
//       }
//       return fs.createReadStream(path);
//     });
//     return fileStreams;
//   } catch (error) {
//     console.error("Error uploading file:", error);
//   }
// }

// // Run the function


// app.post("/upload-on-existing-assisten", async (req, res) => {
//   try {
//     if (!req.files || Object.keys(req.files.file).length === 0) {
//       return res.status(400).send("No files were uploaded.");
//     }

//     const uploadedFiles = Array.isArray(req.files.file) ? req.files.file : [req.files.file];
//     const fileStreams = [];

//     // Prepare streams for each uploaded file
//     for (const file of uploadedFiles) {
//       const storagePath = getStoragePath(file);
//       await file.mv(storagePath);
//       const streams = await uploadFilesToVectorStore(file.name);
//       fileStreams.push(...streams);
//     }

//     // Use the assistant ID provided to find the existing vector store or create one if it doesn't exist
//     const assistantId = req.body.assistantId; // Assume assistantId is passed in the request

//     let vectorStoreId;

//     if (assistantId) {
//       // Retrieve the existing assistant
//       const existingAssistant = await openai.beta.assistants.retrieve(assistantId);

//       if (existingAssistant.tool_resources.file_search.vector_store_ids.length > 0) {
//         // Use the existing vector store ID
//         vectorStoreId = existingAssistant.tool_resources.file_search.vector_store_ids[0];
//       } else {
//         // If no vector store is associated yet, create a new one
//         const newVectorStore = await openai.beta.vectorStores.create({
//           name: 'assistantFilesForChat',
//         });
//         vectorStoreId = newVectorStore.id;

//         // Update assistant with new vector store ID
//         await openai.beta.assistants.update(assistantId, {
//           tool_resources: {
//             file_search: {
//               vector_store_ids: [vectorStoreId],
//             },
//           },
//         });
//       }
//     } else {
//       // Create a new vector store if no assistant ID is provided
//       const newVectorStore = await openai.beta.vectorStores.create({
//         name: 'assistantFilesForChat',
//       });
//       vectorStoreId = newVectorStore.id;

//       // Create a new assistant with this vector store ID
//       const assistant = await openai.beta.assistants.create({
//         name: "file assistants",
//         description: "you answer from the file it is attached under 50 words",
//         model: "gpt-4o-mini",
//         tools: [
//           { type: "file_search" },
//           { type: "code_interpreter" },
//         ],
//         tool_resources: {
//           file_search: {
//             vector_store_ids: [vectorStoreId],
//           },
//         },
//       });

//       res.status(200).json({
//         message: "New assistant created with uploaded files.",
//         assistantId: assistant.id,
//       });
//       return;
//     }

//     // Upload files to the existing vector store
//     await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStoreId, {
//       files: fileStreams,
//     });

//     res.status(200).json({
//       message: "Files uploaded and added to existing assistant's vector store.",
//       assistantId: assistantId,
//     });
//   } catch (error) {
//     console.error("Error uploading files:", error);
//     res.status(500).json({ message: error.message });
//   }
// });



// app.post("/upload-first-time", async (req, res) => {
//   try {
//     if (!req.files || Object.keys(req.files.file).length === 0) {
//       return res.status(400).send("No files were uploaded.");
//     }
//     const uploadedFile = req.files.file;
//     let profileImage;
//     let storagePath;
//     const uploadedFiles = Array.isArray(req.files.file) ? req.files.file : [req.files.file];
//     const fileStreams = [];

//     if (uploadedFile) {
//       for (const file of uploadedFiles) {
//         const storagePath = getStoragePath(file);
//         await file.mv(storagePath);
//         const streems = await uploadFilesToVectorStore(file.name);
//         fileStreams.push(...streems);
//     }
//   }
//   let vectorStore = await openai.beta.vectorStores.create({
//     name: 'assisstentFielsforchat',
//   });
//     const fileIds =
//     await openai.beta.vectorStores.fileBatches.uploadAndPoll(vectorStore.id, {
//       files: fileStreams,
//     }
//   );
//   const assistant = await openai.beta.assistants.create({
//     name: "file assistants",
//     description: "you  answer from the file it is attached under 50 words",
//     model: "gpt-4o-mini",
//     tools: [
//       { type: "file_search" },
//       {
//         type: "code_interpreter",
//       },
//     ],
//     tool_resources: {
//       file_search: {
//         vector_store_ids: [fileIds?.vector_store_id],
//       },
//     },
//   });
//     res.status(200).json({ assistantId: assistant });
//   } catch (error) {
//     console.error(error);
//     res.status(500).json({ message: error.message });
//     return;
//   }
// });

