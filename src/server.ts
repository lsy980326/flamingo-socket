import dotenv from "dotenv";
dotenv.config();

import express, { Express, Request, Response } from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import cors from "cors";
import { connectConsumer } from "./services/kafka.consumer";
import connectDB from "./config/db";
import jwt from "jsonwebtoken";
import { PageModel } from "./models/page.model";
import { ProjectModel } from "./models/project.model";
import { CanvasModel } from "./models/canvas.model";
import { LayerModel } from "./models/layer.model";

connectDB();
connectConsumer();

const app: Express = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// 기본 라우트
app.get("/", (req: Request, res: Response) => {
  res.send("Flamingo Socket Server is running!");
});

// JWT 인증 미들웨어
io.use((socket, next) => {
  const token = socket.handshake.auth.token;

  if (!token) {
    // 토큰이 없으면 연결 거부
    return next(new Error("Authentication error: No token provided."));
  }

  jwt.verify(token, process.env.JWT_SECRET!, (err: any, decoded: any) => {
    if (err) {
      // 토큰이 유효하지 않으면 연결 거부
      console.error("[Auth] Invalid token:", err.message);
      return next(new Error("Authentication error: Invalid token."));
    }

    socket.data.user = { id: decoded.id, email: decoded.email };
    next();
  });
});

// Socket.IO 연결 이벤트
io.on("connection", (socket) => {
  console.log(
    `[Socket.IO] Authenticated user connected: ${socket.data.user.email} (userID: ${socket.data.user.id}) (socketID: ${socket.id})`
  );

  //프로젝트 입장
  socket.on("join-project", async (projectId: string) => {
    try {
      console.log(`--- [JOIN-PROJECT] START ---`);
      console.log(`[JOIN-PROJECT] Received projectId: ${projectId}`);
      console.log(
        `[JOIN-PROJECT] Socket User ID: ${
          socket.data.user.id
        } (Type: ${typeof socket.data.user.id})`
      );

      const project = await ProjectModel.findOne({ _id: projectId });

      if (!project) {
        console.error(
          `[JOIN-PROJECT] CRITICAL: Project not found in MongoDB for _id: ${projectId}`
        );
        socket.emit("error", { message: "Project not found." });
        return;
      }

      console.log(
        `[JOIN-PROJECT] Found project in DB. Collaborators:`,
        JSON.stringify(project.collaborators, null, 2)
      );

      const userFromCollaborators = project.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      );

      console.log(`[JOIN-PROJECT] Result of find():`, userFromCollaborators);

      const canJoin = !!userFromCollaborators; // find 결과가 있으면 true, 없으면(undefined) false

      console.log(
        `[JOIN-PROJECT] Permission check result (canJoin): ${canJoin}`
      );
      console.log(`--- [JOIN-PROJECT] END ---`);

      if (!canJoin) {
        socket.emit("error", {
          message: "You do not have permission to join this project.",
        });
        return;
      }

      socket.join(projectId);
      console.log(
        `[Room] User ${socket.data.user.email} joined project room: ${projectId}`
      );

      const [pages, canvases, layers] = await Promise.all([
        PageModel.find({ projectId }).sort({ order: 1 }).lean(),
        CanvasModel.find({ projectId }).sort({ order: 1 }).lean(),
        LayerModel.find({ projectId }).sort({ order: 1 }).lean(),
      ]);

      socket.emit("initial-data", { pages, canvases, layers });
      console.log(
        `[Initial Data] Sent initial data for project ${projectId} to ${socket.data.user.email}`
      );
    } catch (error) {
      socket.emit("error", { message: "Failed to join project." });
    }
  });

  // 페이지 생성
  socket.on("create-page", async ({ projectId, name }) => {
    try {
      // 권한 재확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        socket.emit("error", {
          message: "Only owners or editors can create pages.",
        });
        return;
      }

      // 가장 마지막 순서 계산
      const lastPage = await PageModel.findOne({ projectId }).sort({
        order: -1,
      });
      const newOrder = lastPage ? lastPage.order + 1 : 0;

      const newPage = await PageModel.create({
        projectId,
        name,
        order: newOrder,
      });

      // Room에 있는 모든 클라이언트에게 브로드캐스트
      io.to(projectId).emit("page-created", newPage);
      console.log(
        `[Page] New page created in project ${projectId} by ${socket.data.user.email}`
      );
    } catch (error) {
      socket.emit("error", { message: "Failed to create page." });
    }
  });

  socket.on(
    "create-canvas",
    async ({ pageId, projectId, name, width, height, unit }) => {
      try {
        // 권한 확인 (프로젝트 참여자인지, editor 이상인지 등)
        const project = await ProjectModel.findOne({ _id: projectId });
        const userRole = project?.collaborators.find(
          (c) => c.userId === Number(socket.data.user.id)
        )?.role;

        if (userRole !== "owner" && userRole !== "editor") {
          return socket.emit("error", {
            message: "Only owners or editors can create canvases.",
          });
        }

        // 해당 페이지가 존재하는지 확인
        const parentPage = await PageModel.findById(pageId);
        if (!parentPage) {
          return socket.emit("error", { message: "Parent page not found." });
        }

        // 순서 계산
        const lastCanvas = await CanvasModel.findOne({ pageId }).sort({
          order: -1,
        });
        const newOrder = lastCanvas ? lastCanvas.order + 1 : 0;

        const newCanvas = await CanvasModel.create({
          pageId,
          projectId, // projectId도 함께 저장
          name,
          width,
          height,
          unit,
          order: newOrder,
        });

        // 프로젝트 Room에 있는 모든 클라이언트에게 브로드캐스트
        io.to(projectId).emit("canvas-created", newCanvas);
        console.log(
          `[Canvas] New canvas '${name}' created on page ${pageId} by ${socket.data.user.email}`
        );
      } catch (error) {
        console.error(`[Error] Failed to create canvas:`, error);
        socket.emit("error", { message: "Failed to create canvas." });
      }
    }
  );

  socket.on("create-layer", async ({ canvasId, projectId, name, type }) => {
    try {
      // 권한 확인 (editor 이상)
      const project = await ProjectModel.findOne({ _id: projectId });
      const userRole = project?.collaborators.find(
        (c) => c.userId === Number(socket.data.user.id)
      )?.role;
      if (userRole !== "owner" && userRole !== "editor") {
        return socket.emit("error", {
          message: "Only owners or editors can create layers.",
        });
      }

      // 부모 캔버스 존재 확인
      const parentCanvas = await CanvasModel.findById(canvasId);
      if (!parentCanvas) {
        return socket.emit("error", { message: "Parent canvas not found." });
      }

      // 순서 계산
      const lastLayer = await LayerModel.findOne({ canvasId }).sort({
        order: -1,
      });
      const newOrder = lastLayer ? lastLayer.order + 1 : 0;

      const newLayer = await LayerModel.create({
        canvasId,
        projectId,
        name,
        type,
        order: newOrder,
      });

      // 프로젝트 Room에 브로드캐스트
      io.to(projectId).emit("layer-created", newLayer);
      console.log(`[Layer] New layer '${name}' created on canvas ${canvasId}`);
    } catch (error) {
      console.error(`[Error] Failed to create layer:`, error);
      socket.emit("error", { message: "Failed to create layer." });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[Socket.IO] user disconnected: ${socket.id}`);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Server] Server is running at http://localhost:${PORT}`);
});
