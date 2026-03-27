"use client";

export default function SheetCreationForm({
  songUrl,
  onSongUrlChange,
  cleanLevel,
  onCleanLevelChange,
  onSubmit,
  status = "idle",
  error = "",
  submitLabel = "Create piano sheet",
  submittingLabel = "Creating sheet...",
  songHelperText = "",
  submitButtonClassName = "",
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="songUrl" className="block text-sm font-medium text-neutral-900">
          Song link
        </label>
        <input
          id="songUrl"
          type="url"
          placeholder="Paste a YouTube link, audio URL, etc."
          value={songUrl}
          onChange={(event) => onSongUrlChange(event.target.value)}
          className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none ring-0 transition focus:border-neutral-950 focus:ring-1 focus:ring-neutral-950"
        />
        {songHelperText ? (
          <p className="text-xs text-neutral-500">{songHelperText}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="cleanLevel"
          className="block text-sm font-medium text-neutral-900"
        >
          Mode
        </label>
        <select
          id="cleanLevel"
          value={cleanLevel}
          onChange={(event) => onCleanLevelChange(event.target.value)}
          className="w-full rounded-xl border border-neutral-300 bg-white px-3 py-2.5 text-sm text-neutral-950 outline-none ring-0 transition focus:border-neutral-950 focus:ring-1 focus:ring-neutral-950"
        >
          <option value="simple">Simple - cleaner, fewer notes</option>
          <option value="regular">Regular - balanced detail</option>
        </select>
        <p className="text-xs text-neutral-500">
          Choose a cleaner arrangement or a fuller balanced one.
        </p>
      </div>

      {error && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-900">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "pending"}
        className={submitButtonClassName}
      >
        {status === "pending" ? submittingLabel : submitLabel}
      </button>
    </form>
  );
}
