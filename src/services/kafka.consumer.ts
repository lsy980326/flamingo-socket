import { Kafka, Consumer } from "kafkajs";
import { ProjectModel } from "../models/project.model";

const isProduction = process.env.NODE_ENV === "production";
console.log(
  `[Kafka Consumer] Running in ${
    isProduction ? "PRODUCTION" : "DEVELOPMENT"
  } mode.`
);

let kafka: Kafka;

if (isProduction) {
  kafka = new Kafka({
    clientId: "flamingo-socket-server", // 클라이언트 ID
    brokers: process.env.KAFKA_BROKERS!.split(",").map((b) => b.trim()),
    ssl: true,
  });
} else {
  // --- 로컬 개발 환경 설정 ---
  kafka = new Kafka({
    clientId: "flamingo-socket-server-local",
    brokers: ["localhost:29092"],
  });
}

const consumer: Consumer = kafka.consumer({
  groupId: "flamingo-socket-group",
  // Kafka 클러스터가 안정화될 시간을 주기 위해 재조정 타임아웃을 늘림
  rebalanceTimeout: 60000,
});

export const connectConsumer = async () => {
  try {
    await consumer.connect();
    console.log("✅ Kafka Consumer connected");

    await consumer.subscribe({ topic: "PROJECTS_V1", fromBeginning: true });
    await consumer.subscribe({
      topic: "COLLABORATORS_V1",
      fromBeginning: true,
    });

    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        if (!message.value) return;

        const payload = JSON.parse(message.value.toString());
        console.log(`[Kafka] Message received on topic ${topic}:`, payload);

        // PROJECTS_V1 토픽 처리
        if (topic === "PROJECTS_V1") {
          switch (payload.event) {
            case "PROJECT_CREATED": {
              const { id, name, owner_id } = payload.data;
              const ownerIdNum = Number(owner_id);
              await ProjectModel.create({
                _id: id,
                name,
                ownerId: ownerIdNum,
                collaborators: [{ userId: ownerIdNum, role: "owner" }],
              });
              console.log(`[DB] Project ${id} created in MongoDB.`);
              break;
            }
            case "PROJECT_DELETED": {
              const { projectId } = payload.data;
              const result = await ProjectModel.deleteOne({ _id: projectId });

              if (result.deletedCount > 0) {
                console.log(`[DB] Project ${projectId} deleted from MongoDB.`);
              } else {
                console.warn(
                  `[DB] Project ${projectId} to delete was not found in MongoDB.`
                );
              }
              break;
            }
          }
        }

        // COLLABORATORS_V1 토픽 처리
        if (topic === "COLLABORATORS_V1") {
          const { projectId, userId, role, newRole } = payload.data;
          const userIdNum = Number(userId);

          switch (payload.event) {
            case "COLLABORATOR_ADDED":
              await ProjectModel.updateOne(
                { _id: projectId },
                { $push: { collaborators: { userId: userIdNum, role } } }
              );
              console.log(
                `[DB] Collaborator ${userIdNum} added to project ${projectId}`
              );
              break;

            case "COLLABORATOR_ROLE_UPDATED":
              await ProjectModel.updateOne(
                { _id: projectId, "collaborators.userId": userIdNum },
                { $set: { "collaborators.$.role": newRole } }
              );
              console.log(
                `[DB] Collaborator ${userIdNum}'s role updated in project ${projectId}`
              );
              break;

            case "COLLABORATOR_REMOVED":
              await ProjectModel.updateOne(
                { _id: projectId },
                { $pull: { collaborators: { userId: userIdNum } } }
              );
              console.log(
                `[DB] Collaborator ${userIdNum} removed from project ${projectId}`
              );
              break;
          }
        }
      },
    });
  } catch (error) {
    console.error("❌ Failed to connect Kafka Consumer:", error);
    process.exit(1);
  }
};
