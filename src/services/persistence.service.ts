import { debounce, DebouncedFunc } from "lodash";
import { LayerModel } from "../models/layer.model";
import redisClient from "./redis.client";
import logger from "../config/logger";
import { YjsDocModel } from "../models/yjsdoc.model";

// Debounce된 함수들을 저장할 Map
// key: layerId, value: debounce된 saveToMongo 함수
const debouncedSavers = new Map<string, DebouncedFunc<() => Promise<void>>>();

// MongoDB에 저장하는 실제 함수
const saveToMongo_layer = async (layerId: string) => {
  const key = `yjs-doc:${layerId}`;
  try {
    // 1. Redis에서 최신 데이터 가져오기
    const docUpdateBuffer = await redisClient.getBuffer(key);

    if (docUpdateBuffer) {
      // 2. MongoDB의 해당 레이어 'data' 필드 업데이트
      await LayerModel.findByIdAndUpdate(layerId, {
        $set: { data: docUpdateBuffer },
      });
      logger.info(`[Persistence] Layer ${layerId} data saved to MongoDB.`);
    }
  } catch (error) {
    logger.error(
      `[Persistence] Failed to save layer ${layerId} to MongoDB:`,
      error
    );
  }
};

export const debouncedSaveToMongo_layer = (layerId: string) => {
  if (!debouncedSavers.has(layerId)) {
    // 이 layerId에 대한 debounce 함수가 없으면 새로 생성
    // 마지막 호출 후 5000ms (5초)가 지나면 saveToMongo 함수를 실행
    const newDebouncedSaver = debounce(() => saveToMongo_layer(layerId), 5000, {
      leading: false, // 처음 호출 시 즉시 실행하지 않음
      trailing: true, // 그룹의 마지막 호출 후 실행
    });
    debouncedSavers.set(layerId, newDebouncedSaver);
  }

  // 해당 layerId의 debounce 함수를 호출
  debouncedSavers.get(layerId)!();
};

// 메모리(Redis)에 있는 Yjs 문서를 MongoDB의 yjs_docs 컬렉션에 저장
const saveToMongo_canvas = async (docName: string) => {
  const redisKey = `yjs-doc:${docName}`; // 캔버스용 Redis 키
  try {
    const docUpdateBuffer = await redisClient.getBuffer(redisKey);
    if (docUpdateBuffer) {
      await YjsDocModel.findByIdAndUpdate(
        docName, // _id 필드
        { data: docUpdateBuffer },
        { upsert: true, new: true }
      );
      logger.info(
        `[Persistence] YjsDoc '${docName}' (Canvas) saved to MongoDB.`
      );
    }
  } catch (error) {
    logger.error(
      `[Persistence] Failed to save YjsDoc '${docName}' to MongoDB:`,
      error
    );
  }
};

//Debounce를 적용하여 MongoDB에 캔버스 단위 Yjs 문서를 저장
export const debouncedSaveToMongo_canvas = (docName: string) => {
  // Map의 키로 docName을 사용
  if (!debouncedSavers.has(docName)) {
    const newDebouncedSaver = debounce(
      () => saveToMongo_canvas(docName),
      5000,
      {
        leading: false,
        trailing: true,
      }
    );
    // Map에 docName을 키로 저장
    debouncedSavers.set(docName, newDebouncedSaver);
  }
  // docName으로 저장된 함수를 호출
  debouncedSavers.get(docName)!();
};

/**
 * 서버 종료 등 비상 상황 시, 현재 Debounce 대기 중인 모든 작업을 즉시 실행
 */
export const flushAllPendingSaves = () => {
  logger.info("[Persistence] Flushing all pending saves to MongoDB...");
  debouncedSavers.forEach((saver) => saver.flush());
};
