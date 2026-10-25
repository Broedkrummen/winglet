import { getRecordingPermissionsAsync, requestRecordingPermissionsAsync } from 'expo-audio';

/** Android can pause the activity even for an already-granted permission request. */
export async function microphonePermission(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const current = await getRecordingPermissionsAsync();
  if (signal.aborted) return false;
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await requestRecordingPermissionsAsync()).granted;
}
