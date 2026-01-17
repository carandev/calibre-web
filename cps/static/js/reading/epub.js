/* global $, calibre, EPUBJS, ePubReader */

var reader;

// Reading Progress Sync Module
var ReadingProgressSync = (function() {
    "use strict";
    
    var saveTimeout = null;
    var lastSavedPosition = null;
    var DEBOUNCE_MS = 2000; // Wait 2 seconds after last page change before saving
    
    /**
     * Generate a unique device ID for this browser
     */
    function getDeviceId() {
        var key = "calibre.reader.deviceId";
        var deviceId = localStorage.getItem(key);
        if (!deviceId) {
            deviceId = "browser-" + Math.random().toString(36).substring(2, 15);
            localStorage.setItem(key, deviceId);
        }
        return deviceId;
    }
    
    /**
     * Load reading progress from server API
     * Returns a Promise that resolves with the progress data or null
     */
    function loadFromServer() {
        if (!calibre.isAuthenticated || !calibre.readingProgressUrl) {
            return Promise.resolve(null);
        }
        
        return new Promise(function(resolve) {
            $.ajax(calibre.readingProgressUrl, {
                method: "GET",
                dataType: "json"
            }).done(function(data) {
                if (data && data.position) {
                    console.log("[ReadingProgress] Loaded from server:", data);
                    resolve(data);
                } else {
                    resolve(null);
                }
            }).fail(function(xhr, status, error) {
                console.warn("[ReadingProgress] Failed to load from server:", error);
                resolve(null);
            });
        });
    }
    
    /**
     * Save reading progress to server API (debounced)
     */
    function saveToServer(progressData) {
        if (!calibre.isAuthenticated || !calibre.readingProgressUrl) {
            return;
        }
        
        // Clear any pending save
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
        
        // Debounce: wait before saving to avoid too many requests
        saveTimeout = setTimeout(function() {
            var csrftoken = $("input[name='csrf_token']").val();
            
            var payload = {
                progress_percent: progressData.percentage * 100,
                position: {
                    cfi: progressData.cfi,
                    percentage: progressData.percentage
                },
                device_id: getDeviceId()
            };
            
            // Don't save if position hasn't changed
            var positionKey = progressData.cfi + "-" + progressData.percentage;
            if (lastSavedPosition === positionKey) {
                return;
            }
            
            $.ajax(calibre.readingProgressUrl, {
                method: "POST",
                contentType: "application/json",
                data: JSON.stringify(payload),
                headers: { "X-CSRFToken": csrftoken }
            }).done(function() {
                lastSavedPosition = positionKey;
                console.log("[ReadingProgress] Saved to server:", Math.round(progressData.percentage * 100) + "%");
            }).fail(function(xhr, status, error) {
                console.warn("[ReadingProgress] Failed to save to server:", error);
            });
        }, DEBOUNCE_MS);
    }
    
    /**
     * Save to localStorage (fallback/cache)
     */
    function saveToLocal(positionKey, progressData) {
        try {
            localStorage.setItem(positionKey, JSON.stringify(progressData));
        } catch (e) {
            console.warn("[ReadingProgress] Failed to save to localStorage:", e);
        }
    }
    
    /**
     * Load from localStorage
     */
    function loadFromLocal(positionKey) {
        try {
            var saved = localStorage.getItem(positionKey);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.warn("[ReadingProgress] Failed to load from localStorage:", e);
        }
        return null;
    }
    
    return {
        getDeviceId: getDeviceId,
        loadFromServer: loadFromServer,
        saveToServer: saveToServer,
        saveToLocal: saveToLocal,
        loadFromLocal: loadFromLocal
    };
})();

(function () {
    "use strict";

    EPUBJS.filePath = calibre.filePath;
    EPUBJS.cssPath = calibre.cssPath;

    reader = ePubReader(calibre.bookUrl, {
        restore: true,
        bookmarks: calibre.bookmark ? [calibre.bookmark] : [],
    });

    Object.keys(themes).forEach(function (theme) {
        reader.rendition.themes.register(theme, themes[theme].css_path);
    });

    if (calibre.useBookmarks) {
        reader.on("reader:bookmarked", updateBookmark.bind(reader, "add"));
        reader.on("reader:unbookmarked", updateBookmark.bind(reader, "remove"));
    } else {
        $("#bookmark, #show-Bookmarks").remove();
    }

    // Enable swipe support
    // I have no idea why swiperRight/swiperLeft from plugins is not working, events just don't get fired
    var touchStart = 0;
    var touchEnd = 0;

    reader.rendition.on('touchstart', function(event) {
        touchStart = event.changedTouches[0].screenX;
    });
    reader.rendition.on('touchend', function(event) {
      touchEnd = event.changedTouches[0].screenX;
        if (touchStart < touchEnd) {
            if(reader.book.package.metadata.direction === "rtl") {
    			reader.rendition.next();
    		} else {
    			reader.rendition.prev();
    		}
            // Swiped Right
        }
        if (touchStart > touchEnd) {
            if(reader.book.package.metadata.direction === "rtl") {
    			reader.rendition.prev();
    		} else {
                reader.rendition.next();
    		}
            // Swiped Left
        }
    });

    // Update progress percentage
    let progressDiv = document.getElementById("progress");
    // Pages counter (virtual pages via EPUB locations)
    let pagesDiv = document.getElementById("pages-count");
    // Honor saved visibility preference for pages counter
    (function () {
        try {
            var pref = localStorage.getItem("calibre.reader.showPages");
            var show = pref === null ? true : pref === "true";
            if (pagesDiv)
                pagesDiv.style.visibility = show ? "visible" : "hidden";
        } catch (e) {}
    })();

    reader.book.ready.then(() => {
        let locations_key = reader.book.key() + "-locations";
        // Key to persist last-read position for this book in localStorage
        let position_key = "calibre.reader.position." + reader.book.key();
        let stored_locations = localStorage.getItem(locations_key);
        let make_locations, save_locations;
        if (stored_locations) {
            make_locations = Promise.resolve(
                reader.book.locations.load(stored_locations)
            );
            // No-op because locations are already saved
            save_locations = () => {};
        } else {
            make_locations = reader.book.locations.generate();
            save_locations = () => {
                localStorage.setItem(
                    locations_key,
                    reader.book.locations.save()
                );
            };
        }
        make_locations
            .then(() => {
                // Try to restore position: first from server API, then from localStorage
                return ReadingProgressSync.loadFromServer().then(function(serverData) {
                    var localData = ReadingProgressSync.loadFromLocal(position_key);
                    var positionToRestore = null;
                    
                    // Determine which position to use (most recent)
                    if (serverData && serverData.position && serverData.position.cfi) {
                        if (localData && localData.cfi) {
                            // Both exist - use server data (it's the source of truth for multi-device)
                            // In the future, we could compare timestamps
                            positionToRestore = serverData.position;
                            console.log("[ReadingProgress] Using server position");
                        } else {
                            positionToRestore = serverData.position;
                            console.log("[ReadingProgress] Using server position (no local)");
                        }
                    } else if (localData && localData.cfi) {
                        positionToRestore = localData;
                        console.log("[ReadingProgress] Using local position (no server)");
                    }
                    
                    // Restore the position
                    if (positionToRestore && positionToRestore.cfi) {
                        try {
                            reader.rendition.display(positionToRestore.cfi);
                        } catch (e) {
                            console.warn("[ReadingProgress] Failed to restore position:", e);
                        }
                    }
                });
            })
            .then(() => {
                reader.rendition.on("relocated", (location) => {
                    let percentage = Math.round(location.end.percentage * 100);
                    progressDiv.textContent = percentage + "%";

                    // Pages based on generated EPUB locations (CFI positions)
                    const cfi = location.start.cfi;
                    const current =
                        reader.book.locations.locationFromCfi(cfi) || 0; // 1-based index typically
                    const total = reader.book.locations.length() || 0;

                    if (total > 0) {
                        pagesDiv.textContent = current + "/" + total;
                        pagesDiv.style.visibility = "visible";
                    } else {
                        pagesDiv.textContent = "";
                        pagesDiv.style.visibility = "hidden";
                    }

                    // Progress data to save
                    var progressData = {
                        cfi: location.start.cfi,
                        percentage: location.start.percentage,
                    };
                    
                    // Save to localStorage (immediate, for fast restore)
                    ReadingProgressSync.saveToLocal(position_key, progressData);
                    
                    // Save to server API (debounced, for cross-device sync)
                    ReadingProgressSync.saveToServer(progressData);
                });
                reader.rendition.reportLocation();
                progressDiv.style.visibility = "visible";
            })
            .then(save_locations);
    });

    /**
     * @param {string} action - Add or remove bookmark
     * @param {string|int} location - Location or zero
     */
    function updateBookmark(action, location) {
        // Remove other bookmarks (there can only be one)
        if (action === "add") {
            this.settings.bookmarks
                .filter(function (bookmark) {
                    return bookmark && bookmark !== location;
                })
                .map(
                    function (bookmark) {
                        this.removeBookmark(bookmark);
                    }.bind(this)
                );
        }

        var csrftoken = $("input[name='csrf_token']").val();

        // Save to database
        $.ajax(calibre.bookmarkUrl, {
            method: "post",
            data: { bookmark: location || "" },
            headers: { "X-CSRFToken": csrftoken },
        }).fail(function (xhr, status, error) {
            alert(error);
        });
    }

    // Default settings load
    const theme = localStorage.getItem("calibre.reader.theme") ?? "lightTheme";
    selectTheme(theme);

    // Restore saved font and font size after reader is ready
    reader.book.ready.then(() => {
        const savedFontSize = localStorage.getItem("calibre.reader.fontSize");
        if (savedFontSize) {
            reader.rendition.themes.fontSize(`${savedFontSize}%`);
        }

        const savedFont = localStorage.getItem("calibre.reader.font");
        if (savedFont && window.selectFont) {
            window.selectFont(savedFont);
        }
    });
})();
