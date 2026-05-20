import { useCallback, useEffect, useRef, useState } from "react";
import { updateGlobalSettings, type ModelInfo } from "../api";
import { useModelsCache } from "./useModelsCache";

/**
 * Favorite model/provider state and actions consumed by the dashboard App shell.
 */
export interface UseFavoritesResult {
  availableModels: ModelInfo[];
  favoriteProviders: string[];
  favoriteModels: string[];
  toggleFavoriteProvider: (provider: string) => Promise<void>;
  toggleFavoriteModel: (modelId: string) => Promise<void>;
}

/**
 * Loads model catalog + favorites and exposes optimistic favorite toggles.
 */
export function useFavorites(): UseFavoritesResult {
  const { models, favoriteProviders: cachedFavoriteProviders, favoriteModels: cachedFavoriteModels, refresh } = useModelsCache();
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>(models);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>(cachedFavoriteProviders);
  const [favoriteModels, setFavoriteModels] = useState<string[]>(cachedFavoriteModels);
  const favoriteProvidersRef = useRef<string[]>(favoriteProviders);
  const favoriteModelsRef = useRef<string[]>(favoriteModels);

  useEffect(() => {
    setAvailableModels(models);
  }, [models]);

  useEffect(() => {
    favoriteProvidersRef.current = cachedFavoriteProviders;
    setFavoriteProviders(cachedFavoriteProviders);
  }, [cachedFavoriteProviders]);

  useEffect(() => {
    favoriteModelsRef.current = cachedFavoriteModels;
    setFavoriteModels(cachedFavoriteModels);
  }, [cachedFavoriteModels]);

  useEffect(() => {
    favoriteProvidersRef.current = favoriteProviders;
  }, [favoriteProviders]);

  useEffect(() => {
    favoriteModelsRef.current = favoriteModels;
  }, [favoriteModels]);

  const toggleFavoriteProvider = useCallback(async (provider: string) => {
    const previousFavorites = favoriteProvidersRef.current;
    const isFavorite = previousFavorites.includes(provider);
    const nextFavorites = isFavorite
      ? previousFavorites.filter((p) => p !== provider)
      : [provider, ...previousFavorites];

    favoriteProvidersRef.current = nextFavorites;
    setFavoriteProviders(() => nextFavorites);

    try {
      await updateGlobalSettings({
        favoriteProviders: nextFavorites,
        favoriteModels: favoriteModelsRef.current,
      });
      await refresh();
    } catch (error) {
      favoriteProvidersRef.current = previousFavorites;
      setFavoriteProviders(() => previousFavorites);
      throw error;
    }
  }, [refresh]);

  const toggleFavoriteModel = useCallback(async (modelId: string) => {
    const previousFavorites = favoriteModelsRef.current;
    const isFavorite = previousFavorites.includes(modelId);
    const nextFavorites = isFavorite
      ? previousFavorites.filter((id) => id !== modelId)
      : [modelId, ...previousFavorites];

    favoriteModelsRef.current = nextFavorites;
    setFavoriteModels(() => nextFavorites);

    try {
      await updateGlobalSettings({
        favoriteProviders: favoriteProvidersRef.current,
        favoriteModels: nextFavorites,
      });
      await refresh();
    } catch (error) {
      favoriteModelsRef.current = previousFavorites;
      setFavoriteModels(() => previousFavorites);
      throw error;
    }
  }, [refresh]);

  return {
    availableModels,
    favoriteProviders,
    favoriteModels,
    toggleFavoriteProvider,
    toggleFavoriteModel,
  };
}
