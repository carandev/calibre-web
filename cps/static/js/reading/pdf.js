/* global calibre, PDFViewerApplication */

/**
 * Reading Progress Sync Module for PDF Reader
 * Synchronizes reading position (page number) with the server API
 */
var ReadingProgressSync = (function() {
    "use strict";
    
    var saveTimeout = null;
    var lastSavedPosition = null;
    var DEBOUNCE_MS = 2000; // Wait 2 seconds after last page change before saving
    var initialized = false;
    
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
        if (!calibre || !calibre.isAuthenticated || !calibre.readingProgressUrl) {
            return Promise.resolve(null);
        }
        
        return new Promise(function(resolve) {
            fetch(calibre.readingProgressUrl, {
                method: "GET",
                headers: {
                    "Accept": "application/json"
                }
            })
            .then(function(response) {
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                return response.json();
            })
            .then(function(data) {
                if (data && data.position) {
                    console.log("[ReadingProgress] Loaded from server:", data);
                    resolve(data);
                } else {
                    resolve(null);
                }
            })
            .catch(function(error) {
                console.warn("[ReadingProgress] Failed to load from server:", error);
                resolve(null);
            });
        });
    }
    
    /**
     * Save reading progress to server API (debounced)
     */
    function saveToServer(page, totalPages) {
        if (!calibre || !calibre.isAuthenticated || !calibre.readingProgressUrl) {
            return;
        }
        
        // Clear any pending save
        if (saveTimeout) {
            clearTimeout(saveTimeout);
        }
        
        // Debounce: wait before saving to avoid too many requests
        saveTimeout = setTimeout(function() {
            var progressPercent = totalPages > 0 ? (page / totalPages) * 100 : 0;
            
            var payload = {
                progress_percent: progressPercent,
                position: {
                    page: page,
                    total_pages: totalPages
                },
                device_id: getDeviceId()
            };
            
            // Don't save if position hasn't changed
            var positionKey = page + "-" + totalPages;
            if (lastSavedPosition === positionKey) {
                return;
            }
            
            // Get CSRF token from meta tag or cookie
            var csrfToken = getCSRFToken();
            
            fetch(calibre.readingProgressUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-CSRFToken": csrfToken
                },
                body: JSON.stringify(payload)
            })
            .then(function(response) {
                if (!response.ok) {
                    throw new Error("HTTP " + response.status);
                }
                lastSavedPosition = positionKey;
                console.log("[ReadingProgress] Saved to server: page " + page + "/" + totalPages + " (" + Math.round(progressPercent) + "%)");
            })
            .catch(function(error) {
                console.warn("[ReadingProgress] Failed to save to server:", error);
            });
        }, DEBOUNCE_MS);
    }
    
    /**
     * Get CSRF token from various sources
     */
    function getCSRFToken() {
        // Try meta tag
        var metaTag = document.querySelector('meta[name="csrf-token"]');
        if (metaTag) {
            return metaTag.getAttribute("content");
        }
        
        // Try input field
        var inputField = document.querySelector('input[name="csrf_token"]');
        if (inputField) {
            return inputField.value;
        }
        
        // Try cookie
        var cookies = document.cookie.split(";");
        for (var i = 0; i < cookies.length; i++) {
            var cookie = cookies[i].trim();
            if (cookie.startsWith("csrf_token=")) {
                return cookie.substring("csrf_token=".length);
            }
        }
        
        return "";
    }
    
    /**
     * Save to localStorage (fallback/cache)
     */
    function saveToLocal(page, totalPages) {
        if (!calibre || !calibre.bookId) {
            return;
        }
        
        var key = "calibre.reader.pdf.position." + calibre.bookId;
        try {
            localStorage.setItem(key, JSON.stringify({
                page: page,
                total_pages: totalPages,
                timestamp: Date.now()
            }));
        } catch (e) {
            console.warn("[ReadingProgress] Failed to save to localStorage:", e);
        }
    }
    
    /**
     * Load from localStorage
     */
    function loadFromLocal() {
        if (!calibre || !calibre.bookId) {
            return null;
        }
        
        var key = "calibre.reader.pdf.position." + calibre.bookId;
        try {
            var saved = localStorage.getItem(key);
            if (saved) {
                return JSON.parse(saved);
            }
        } catch (e) {
            console.warn("[ReadingProgress] Failed to load from localStorage:", e);
        }
        return null;
    }
    
    /**
     * Navigate to a specific page in the PDF viewer
     */
    function goToPage(page) {
        if (typeof PDFViewerApplication !== "undefined" && PDFViewerApplication.pdfViewer) {
            // Ensure page is within valid range
            var totalPages = PDFViewerApplication.pagesCount || 1;
            page = Math.max(1, Math.min(page, totalPages));
            PDFViewerApplication.page = page;
            console.log("[ReadingProgress] Navigated to page " + page);
        }
    }
    
    /**
     * Initialize the reading progress sync
     * Should be called after PDFViewerApplication is ready
     */
    function init() {
        if (initialized) {
            return;
        }
        
        if (typeof PDFViewerApplication === "undefined") {
            console.warn("[ReadingProgress] PDFViewerApplication not found");
            return;
        }
        
        // Wait for the document to be loaded
        PDFViewerApplication.initializedPromise.then(function() {
            console.log("[ReadingProgress] PDF Viewer initialized, setting up progress sync");
            
            // Listen for page changes
            PDFViewerApplication.eventBus.on("pagechanging", function(evt) {
                var page = evt.pageNumber;
                var totalPages = PDFViewerApplication.pagesCount || 1;
                
                // Save to localStorage immediately (for fast restore)
                saveToLocal(page, totalPages);
                
                // Save to server (debounced)
                saveToServer(page, totalPages);
            });
            
            // Load and restore position after document is loaded
            PDFViewerApplication.eventBus.on("documentloaded", function() {
                restorePosition();
            });
            
            initialized = true;
        });
    }
    
    /**
     * Restore reading position from server or localStorage
     */
    function restorePosition() {
        loadFromServer().then(function(serverData) {
            var localData = loadFromLocal();
            var pageToRestore = null;
            
            // Determine which position to use
            if (serverData && serverData.position && serverData.position.page) {
                // Server data exists - use it (source of truth for multi-device sync)
                pageToRestore = serverData.position.page;
                console.log("[ReadingProgress] Using server position: page " + pageToRestore);
            } else if (localData && localData.page) {
                // Only local data exists
                pageToRestore = localData.page;
                console.log("[ReadingProgress] Using local position: page " + pageToRestore);
            }
            
            // Restore the position
            if (pageToRestore && pageToRestore > 1) {
                // Small delay to ensure PDF is fully rendered
                setTimeout(function() {
                    goToPage(pageToRestore);
                }, 100);
            }
        });
    }
    
    return {
        init: init,
        getDeviceId: getDeviceId,
        loadFromServer: loadFromServer,
        saveToServer: saveToServer,
        saveToLocal: saveToLocal,
        loadFromLocal: loadFromLocal,
        goToPage: goToPage,
        restorePosition: restorePosition
    };
})();

// Auto-initialize when the PDF viewer is ready
(function() {
    "use strict";
    
    // Check if calibre config exists (means we're in calibre-web context)
    if (typeof calibre === "undefined" || !calibre.bookId) {
        console.log("[ReadingProgress] Not in calibre-web context, skipping init");
        return;
    }
    
    // Wait for PDF viewer to be available
    function waitForPDFViewer() {
        if (typeof PDFViewerApplication !== "undefined" && PDFViewerApplication.initializedPromise) {
            ReadingProgressSync.init();
        } else {
            // Retry after a short delay
            setTimeout(waitForPDFViewer, 100);
        }
    }
    
    // Start checking when DOM is ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", waitForPDFViewer);
    } else {
        waitForPDFViewer();
    }
})();
