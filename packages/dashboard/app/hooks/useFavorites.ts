import { useCallback, useEffect, useRef, useState } from "react";
import { fetchModels, updateGlobalSettings, type ModelInfo } from "../api";

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
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [favoriteProviders, setFavoriteProviders] = useState<string[]>([]);
  const [favoriteModels, setFavoriteModels] = useState<string[]>([]);
  const favoriteProvidersRef = useRef<string[]>(favoriteProviders);
  const favoriteModelsRef = useRef<string[]>(favoriteModels);

  useEffect(() => {
    fetchModels()
      .then((response) => {
        setAvailableModels(response.models);
        favoriteProvidersRef.current = response.favoriteProviders;
        favoriteModelsRef.current = response.favoriteModels;
        setFavoriteProviders(response.favoriteProviders);
        setFavoriteModels(response.favoriteModels);
      })
      .catch(() => {
        // Keep defaults on fetch failure.
      });
  }, []);

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
    } catch (error) {
      favoriteProvidersRef.current = previousFavorites;
      setFavoriteProviders(() => previousFavorites);
      throw error;
    }
  }, []);

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
    } catch (error) {
      favoriteModelsRef.current = previousFavorites;
      setFavoriteModels(() => previousFavorites);
      throw error;
    }
  }, []);

  return {
    availableModels,
    favoriteProviders,
    favoriteModels,
    toggleFavoriteProvider,
    toggleFavoriteModel,
  };
}
